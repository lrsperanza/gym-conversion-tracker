/**
 * Migrate the "gym-conversion-tracker" schema from Aurora PostgreSQL to Aurora DSQL:
 * schema, tables, constraints, data and indexes — and prove nothing was left behind.
 *
 * Usage (from back/, so bun loads back/.env):
 *   bun run src/scripts/migrate-aurora-to-dsql.ts --dry-run      # inspect: DDL, warnings, row counts / sizes. Writes nothing.
 *   bun run src/scripts/migrate-aurora-to-dsql.ts                # full run (idempotent, safe to re-run)
 *   bun run src/scripts/migrate-aurora-to-dsql.ts --verify-only  # objects + row counts + per-table content checksums
 *
 * Options:
 *   --skip-indexes    do not create secondary indexes
 *   --indexes-only    only (re)create the secondary indexes, then verify (resume after a stop)
 *   --status          show DSQL index jobs and which planned indexes exist / are missing
 *   --concurrency=N   parallel insert batches per table (default 4)
 *   --exclude=a,b     tables to leave out (and their sequences / indexes)
 *   --drop-target     DROP every migrated table in the target schema on DSQL first (start over). Asks nothing.
 *
 * Env (back/.env):
 *   Source (Aurora):  PostgreHost, PostgrePassword, optional PostgrePort / PostgreDatabase / PostgreUser / PostgreSSL
 *   Target (DSQL):    DSQL_ENDPOINT (e.g. abc123.dsql.sa-east-1.on.aws), optional DSQL_REGION,
 *                     AWS credentials (AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)
 *                     allowed to call dsql:DbConnectAdmin on the cluster.
 *
 * Stop the API (Cloud Run) and the evo-payment-checker job before the real run: rows written to Aurora
 * after a table is copied are not picked up (the checksum step will flag it if that happens).
 *
 * DSQL translation (what differs from Aurora):
 *   - ENUM types do not exist in DSQL → the column becomes text + CHECK (col IN (...labels)); every
 *     ::"gym-conversion-tracker".<enum> cast in defaults / CHECKs / partial-index predicates becomes ::text.
 *   - Extensions (pg_trgm, pgcrypto) do not exist. gen_random_uuid() is core, so pgcrypto is not needed.
 *     pg_trgm's similarity() / % moved into the app (src/domain/trigram.ts); this script checks that
 *     port against Aurora's pg_trgm on the real lead names. The 3 GIN trigram indexes cannot exist in
 *     DSQL (B-tree only) and are reported as skipped.
 *   - FOREIGN KEY, CHECK, UNIQUE, JSONB, partial and expression indexes are supported (2026) and copied as-is.
 *   - Indexes are built with CREATE INDEX ASYNC after the data load.
 *   - DSQL limits: 1 DDL per transaction, 3,000 rows / 10 MiB per write transaction, 2 MiB per row.
 */
import pg from "pg";
import { createHash } from "node:crypto";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { isTrigramMatch, trigramSimilarity } from "../domain/trigram";

const { Pool } = pg;

const SCHEMA = "gym-conversion-tracker";

const args = new Set(process.argv.slice(2).filter((a) => !a.includes("=")));
const DRY_RUN = args.has("--dry-run");
const VERIFY_ONLY = args.has("--verify-only");
const SKIP_INDEXES = args.has("--skip-indexes");
const INDEXES_ONLY = args.has("--indexes-only");
const STATUS_ONLY = args.has("--status");
const DROP_TARGET = args.has("--drop-target");
const INDEX_WAIT_MS = 20 * 60_000; // total wait for all index builds
const CONCURRENCY = Number(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? 4);

const EXCLUDE = new Set(
    (process.argv.find((a) => a.startsWith("--exclude="))?.split("=")[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
);

const READ_PAGE_ROWS = 5000; // rows read from Aurora per page (keeps memory flat for big tables like audit_logs)
const MAX_ROWS_PER_BATCH = 1000; // DSQL limit is 3,000 rows per transaction
const MAX_BYTES_PER_BATCH = 4 * 1024 * 1024; // DSQL limit is 10 MiB per transaction
const MAX_ROW_BYTES = 2 * 1024 * 1024; // DSQL row limit
const MAX_PARAMS = 60000; // PostgreSQL protocol limit is 65,535 bind parameters

// ---------------------------------------------------------------------------------------------
// Connections


function sourcePool() {
    const host = process.env.PostgreHost;
    const password = process.env.PostgrePassword;
    if (!host || !password) throw new Error("Set PostgreHost and PostgrePassword (source Aurora).");
    const pool = new Pool({
        host,
        password,
        user: process.env.PostgreUser || "postgres",
        database: process.env.PostgreDatabase || "postgres",
        port: Number(process.env.PostgrePort || 5432),
        ssl: process.env.PostgreSSL === "false" ? false : { rejectUnauthorized: false },
        max: 2,
    });
    pool.on("error", (e) => console.error("Aurora idle client error:", e.message));
    return pool;
}

function targetPool() {
    const hostname = process.env.DSQL_ENDPOINT?.trim();
    if (!hostname) throw new Error("Set DSQL_ENDPOINT in back/.env (target Aurora DSQL cluster endpoint).");
    const region =
        process.env.DSQL_REGION || hostname.match(/\.dsql\.([a-z0-9-]+)\.on\.aws$/)?.[1] || process.env.AWS_REGION;
    if (!region) throw new Error("Set DSQL_REGION.");
    const signer = new DsqlSigner({ hostname, region });
    const pool = new Pool({
        host: hostname,
        port: 5432,
        user: "admin",
        database: "postgres",
        password: () => signer.getDbConnectAdminAuthToken(),
        ssl: { rejectUnauthorized: true },
        max: Math.max(2, CONCURRENCY),
        maxLifetimeSeconds: 50 * 60, // DSQL closes connections after 1 h
    });
    pool.on("error", (e) => console.error("DSQL idle client error:", e.message));
    return pool;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(e: unknown) {
    const err = e as { code?: string; message?: string };
    return (
        err?.code === "40001" ||
        /\(OC00[0-9]\)/.test(String(err?.message ?? "")) ||
        /ECONNRESET|Connection terminated/i.test(String(err?.message ?? ""))
    );
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (e) {
            if (!isRetryable(e) || i >= attempts) throw e;
            await sleep(Math.min(2000, 50 * 2 ** i) * (0.5 + Math.random()));
        }
    }
}

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;
const ql = (value: string) => `'${value.replace(/'/g, "''")}'`;
const S = qi(SCHEMA);
const tq = (table: string) => `${S}.${qi(table)}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------------------------
// Introspection (source)

type Column = {
    name: string;
    type: string; // source type (format_type)
    dstType: string; // type used on DSQL (enums → text)
    notNull: boolean;
    default: string | null;
    identity: string; // '' | 'a' | 'd'
    generated: string; // '' | 's'
    typtype: string; // b=base, e=enum, d=domain, c=composite, r=range, p=pseudo
    elemTyptype: string | null; // for arrays: typtype of the element
    enumType: string | null; // enum type name when typtype = 'e'
    isArray: boolean;
};
type Constraint = { name: string; type: string; def: string; refTable: string | null };
type Index = { name: string; def: string; method: string };
type Table = {
    name: string;
    oid: number;
    columns: Column[];
    constraints: Constraint[];
    indexes: Index[];
    pkColumns: string[];
};
type Intro = {
    tables: Table[];
    sequences: string[];
    functions: string[];
    enums: Map<string, string[]>;
    unsupported: string[]; // objects in the schema this script does not migrate (views, triggers, ...)
};

async function introspect(src: pg.Pool): Promise<Intro> {
    const enumRes = await src.query<{ name: string; labels: string[] }>(
        `SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE n.nspname = $1
         GROUP BY t.typname`,
        [SCHEMA],
    );
    const enums = new Map(enumRes.rows.map((r) => [r.name, r.labels]));

    const tablesRes = await src.query<{ oid: number; name: string; ispartition: boolean; kind: string }>(
        `SELECT c.oid::int AS oid, c.relname AS name, c.relispartition AS ispartition, c.relkind AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
         ORDER BY c.relname`,
        [SCHEMA],
    );

    const unsupported: string[] = [];
    const tables: Table[] = [];
    for (const t of tablesRes.rows) {
        if (t.ispartition || t.kind === "p") {
            unsupported.push(`table ${t.name}: partitioned tables / partitions are not handled by this script`);
            continue;
        }
        const cols = await src.query(
            `SELECT a.attname AS name,
                    format_type(a.atttypid, a.atttypmod) AS type,
                    a.attnotnull AS "notNull",
                    pg_get_expr(d.adbin, d.adrelid) AS "default",
                    a.attidentity AS identity,
                    a.attgenerated AS generated,
                    ty.typtype AS typtype,
                    el.typtype AS "elemTyptype",
                    CASE WHEN ty.typtype = 'e' THEN ty.typname END AS "enumType",
                    (ty.typcategory = 'A') AS "isArray"
             FROM pg_attribute a
             JOIN pg_type ty ON ty.oid = a.atttypid
             LEFT JOIN pg_type el ON el.oid = ty.typelem AND ty.typcategory = 'A'
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`,
            [t.oid],
        );
        const cons = await src.query(
            `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS def,
                    CASE WHEN confrelid <> 0 THEN (SELECT relname FROM pg_class WHERE oid = confrelid) END AS "refTable",
                    conindid::int AS "indexOid"
             FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname`,
            [t.oid],
        );
        const constraintIndexOids = new Set(
            cons.rows.filter((c) => c.type !== "f" && c.indexOid).map((c) => Number(c.indexOid)),
        );
        const idx = await src.query(
            `SELECT ic.relname AS name, i.indexrelid::int AS oid, pg_get_indexdef(i.indexrelid) AS def, am.amname AS method
             FROM pg_index i
             JOIN pg_class ic ON ic.oid = i.indexrelid
             JOIN pg_am am ON am.oid = ic.relam
             WHERE i.indrelid = $1
             ORDER BY ic.relname`,
            [t.oid],
        );
        // Ordered PK columns straight from the catalog (robust to quoting / expressions in the def).
        const pkRes = await src.query<{ name: string }>(
            `SELECT a.attname AS name
             FROM pg_constraint c
             CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             WHERE c.conrelid = $1 AND c.contype = 'p'
             ORDER BY k.ord`,
            [t.oid],
        );
        tables.push({
            name: t.name,
            oid: t.oid,
            columns: (cols.rows as Omit<Column, "dstType">[]).map((c) => ({ ...c, dstType: c.type })),
            constraints: cons.rows.map((c) => ({ name: c.name, type: c.type, def: c.def, refTable: c.refTable })),
            indexes: idx.rows
                .filter((i) => !constraintIndexOids.has(Number(i.oid)))
                .map((i) => ({ name: i.name, def: i.def, method: i.method })),
            pkColumns: pkRes.rows.map((r) => r.name),
        });
    }

    const seqRes = await src.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY 1`,
        [SCHEMA],
    );
    const fnRes = await src.query<{ name: string; lang: string; def: string }>(
        `SELECT p.proname AS name, l.lanname AS lang, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
        [SCHEMA],
    );
    for (const f of fnRes.rows) {
        if (f.lang !== "sql") unsupported.push(`function ${f.name}: language ${f.lang} (DSQL only runs SQL functions)`);
    }

    // Everything else that could live in the schema: report it so nothing is silently left behind.
    const other = await src.query<{ kind: string; name: string }>(
        `SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS kind,
                c.relname::text AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('v', 'm', 'f')
         UNION ALL
         SELECT 'trigger', tg.tgname || ' on ' || c.relname
         FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND NOT tg.tgisinternal
         UNION ALL
         SELECT 'row-level security policy', pol.polname || ' on ' || c.relname
         FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
         UNION ALL
         SELECT 'type (' || t.typtype::text || ')', t.typname::text
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1 AND t.typtype IN ('d', 'r', 'm')
            OR (n.nspname = $1 AND t.typtype = 'c' AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c'))`,
        [SCHEMA],
    );
    for (const o of other.rows) unsupported.push(`${o.kind} ${o.name}: not migrated by this script`);

    return {
        tables,
        sequences: seqRes.rows.map((r) => r.name),
        functions: fnRes.rows.filter((f) => f.lang === "sql").map((f) => f.def),
        enums,
        unsupported,
    };
}

/** Parents before children, so inline FOREIGN KEYs and the data load both work. */
function topoSort(tables: Table[]): Table[] {
    const byName = new Map(tables.map((t) => [t.name, t]));
    const out: Table[] = [];
    const state = new Map<string, "visiting" | "done">();
    const visit = (t: Table) => {
        if (state.get(t.name) === "done") return;
        if (state.get(t.name) === "visiting") return; // cycle: keep going, FK will fail loudly
        state.set(t.name, "visiting");
        for (const c of t.constraints) {
            if (c.type === "f" && c.refTable && c.refTable !== t.name) {
                const parent = byName.get(c.refTable);
                if (parent) visit(parent);
            }
        }
        state.set(t.name, "done");
        out.push(t);
    };
    tables.forEach(visit);
    return out;
}

// ---------------------------------------------------------------------------------------------
// DDL translation

type Plan = {
    functions: string[];
    sequences: string[];
    tables: { table: Table; ddl: string; constraintNames: string[] }[];
    indexes: { table: string; name: string; ddl: string }[];
    skippedIndexes: string[];
    warnings: string[];
    blockers: string[];
};

function buildPlan(intro: Intro): Plan {
    const warnings: string[] = [];
    const blockers: string[] = [...intro.unsupported];
    const tables = topoSort(intro.tables);

    // ::"gym-conversion-tracker".<enum>  (and ::"gym-conversion-tracker"."<enum>", arrays too) → ::text
    const enumNames = [...intro.enums.keys()];
    const enumRe = enumNames.length
        ? new RegExp(
              `(?:${escapeRe(qi(SCHEMA))}|${escapeRe(SCHEMA)})\\.(?:${enumNames
                  .map((n) => `"${escapeRe(n)}"|${escapeRe(n)}`)
                  .join("|")})(?![A-Za-z0-9_$"])`,
              "g",
          )
        : null;
    const deEnum = (s: string) => (enumRe ? s.replace(enumRe, "text") : s);
    const leftover = (s: string) => s.includes(`${qi(SCHEMA)}.`) || s.includes(`${SCHEMA}.`);

    const functions = [
        ...intro.functions.map((def) =>
            deEnum(def)
                .replace(/^CREATE OR REPLACE FUNCTION/i, "CREATE FUNCTION")
                .replace(/\s+PARALLEL\s+\w+/gi, ""),
        ),
    ];

    const sequences = intro.sequences.map((s) => `CREATE SEQUENCE IF NOT EXISTS ${tq(s)} CACHE 1`);

    const tablePlans = tables.map((t) => {
        const lines: string[] = [];
        const constraintNames: string[] = [];
        for (const c of t.columns) {
            if (c.typtype === "e") {
                c.dstType = "text";
                const labels = intro.enums.get(c.enumType!) ?? [];
                const name = `${t.name}_${c.name}_enum_check`.slice(0, 63);
                t.constraints.push({
                    name,
                    type: "c",
                    def: `CHECK (${qi(c.name)} IN (${labels.map(ql).join(", ")}))`,
                    refTable: null,
                });
            } else if (c.isArray && c.elemTyptype === "e") {
                c.dstType = "text[]";
                warnings.push(`${t.name}.${c.name}: enum array "${c.type}" → text[] (labels not enforced)`);
            } else if (c.typtype !== "b" && !c.isArray) {
                blockers.push(`${t.name}.${c.name}: type "${c.type}" (domain/composite/range) is not supported by DSQL`);
            } else if (c.isArray) {
                warnings.push(`${t.name}.${c.name}: array column "${c.type}" — check DSQL support if CREATE TABLE fails`);
            }
            if (leftover(c.dstType)) blockers.push(`${t.name}.${c.name}: custom type "${c.type}" has no DSQL mapping`);

            let line = `${qi(c.name)} ${c.dstType}`;
            const def = c.default === null ? null : deEnum(c.default);
            if (def && leftover(def)) {
                warnings.push(`${t.name}.${c.name}: default references the schema, check it: ${def}`);
            }
            if (c.generated === "s") {
                line += ` GENERATED ALWAYS AS (${def}) STORED`;
            } else if (c.identity) {
                line += c.identity === "a" ? " GENERATED ALWAYS AS IDENTITY" : " GENERATED BY DEFAULT AS IDENTITY";
            } else if (def !== null) {
                line += ` DEFAULT ${def}`;
            }
            if (c.notNull) line += " NOT NULL";
            lines.push(line);
        }
        for (const con of t.constraints) {
            if (con.type === "n") continue; // NOT NULL constraints (PG18 catalogs) are already on the column
            if (con.type === "x") {
                blockers.push(`${t.name}: EXCLUDE constraint ${con.name} (no GiST in DSQL) — enforce it in the app, then --exclude or drop it`);
                continue;
            }
            if (!["p", "u", "c", "f"].includes(con.type)) {
                blockers.push(`${t.name}: constraint ${con.name} of type ${con.type} is not handled`);
                continue;
            }
            lines.push(`CONSTRAINT ${qi(con.name)} ${deEnum(con.def)}`);
            constraintNames.push(con.name);
        }
        if (t.pkColumns.length === 0) {
            warnings.push(`${t.name}: no primary key (DSQL adds a hidden one; a re-run would duplicate rows — use --drop-target to redo)`);
        }
        const ddl = `CREATE TABLE IF NOT EXISTS ${tq(t.name)} (\n    ${lines.join(",\n    ")}\n)`;
        return { table: t, ddl, constraintNames };
    });

    const indexes: Plan["indexes"] = [];
    const skippedIndexes: string[] = [];
    for (const t of tables) {
        for (const i of t.indexes) {
            if (i.method !== "btree") {
                skippedIndexes.push(`${t.name}.${i.name} (${i.method.toUpperCase()}): ${i.def}`);
                continue;
            }
            // CREATE [UNIQUE] INDEX name ON [ONLY] "schema".t USING btree (...) [INCLUDE (...)] [NULLS NOT DISTINCT] [WHERE ...]
            const m = i.def.match(/^CREATE (UNIQUE )?INDEX (\S+) ON (?:ONLY )?(\S+) USING btree (.*)$/s);
            if (!m) {
                blockers.push(`${t.name}: could not parse index ${i.name}: ${i.def}`);
                continue;
            }
            const [, unique = "", name, table, rest] = m;
            indexes.push({
                table: t.name,
                name: i.name,
                ddl: `CREATE ${unique}INDEX ASYNC IF NOT EXISTS ${name} ON ${table} ${deEnum(rest!)}`,
            });
        }
    }
    for (const s of skippedIndexes) {
        warnings.push(`skipped index ${s} — DSQL is B-tree only; name similarity now runs in the app (src/domain/trigram.ts)`);
    }
    return { functions, sequences, tables: tablePlans, indexes, skippedIndexes, warnings, blockers };
}

// ---------------------------------------------------------------------------------------------
// Reading pages (keyset pagination on the primary key; full read when there is none)

type Row = Record<string, string | null>;

/**
 * Every value is read as text. timestamptz::text depends on the session TimeZone, so those columns
 * are rendered explicitly in UTC ("... +00"): the copy and the checksums are then identical whatever
 * TimeZone Aurora or DSQL sessions use.
 */
function textExpr(c: Column) {
    const col = qi(c.name);
    if (c.type === "timestamp with time zone") {
        return `CASE WHEN isfinite(${col}) THEN (${col} AT TIME ZONE 'UTC')::text || '+00' ELSE ${col}::text END`;
    }
    return `${col}::text`;
}

function selectList(cols: Column[]) {
    return cols.map((c) => `${textExpr(c)} AS ${qi(c.name)}`).join(", ");
}

async function* readPages(pool: pg.Pool, t: Table, cols: Column[], side: "src" | "dst"): AsyncGenerator<Row[]> {
    const pkCols = t.pkColumns.map((n) => t.columns.find((c) => c.name === n)!);
    const sel = selectList(cols);
    if (!pkCols.length) {
        const r = await withRetry(() => pool.query<Row>(`SELECT ${sel} FROM ${tq(t.name)}`));
        if (r.rows.length) yield r.rows;
        return;
    }
    // PK values are also selected as text under private aliases so the keyset works even when
    // a PK column is generated / not in `cols`.
    const keyAliases = pkCols.map((_, i) => `__k${i}`);
    const keySel = pkCols.map((c, i) => `${qi(c.name)}::text AS ${keyAliases[i]}`).join(", ");
    const order = pkCols.map((c) => qi(c.name)).join(", ");
    let last: (string | null)[] | null = null;
    for (;;) {
        let where = "";
        if (last) {
            const ph = pkCols.map((c, i) => `$${i + 1}::text::${side === "src" ? c.type : c.dstType}`);
            where = `WHERE (${order}) > (${ph.join(", ")})`;
        }
        const q = `SELECT ${sel}, ${keySel} FROM ${tq(t.name)} ${where} ORDER BY ${order} LIMIT ${READ_PAGE_ROWS}`;
        const params: (string | null)[] = last ?? [];
        const r: pg.QueryResult<Row> = await withRetry(() => pool.query<Row>(q, params));
        if (!r.rows.length) return;
        const lastRow: Row = r.rows[r.rows.length - 1]!;
        last = keyAliases.map((k): string | null => lastRow[k] ?? null);
        for (const row of r.rows) for (const k of keyAliases) delete row[k];
        yield r.rows;
        if (r.rows.length < READ_PAGE_ROWS) return;
    }
}

// ---------------------------------------------------------------------------------------------
// Execution

async function runDdl(dst: pg.Pool, sql: string, label: string) {
    try {
        await withRetry(() => dst.query(sql));
        console.log(`  ✔ ${label}`);
    } catch (e) {
        const msg = (e as Error).message;
        if (/already exists/i.test(msg)) {
            console.log(`  • ${label} (already exists)`);
            return;
        }
        console.error(`  ✘ ${label}\n${sql}\n`);
        throw e;
    }
}

async function copyTable(src: pg.Pool, dst: pg.Pool, t: Table) {
    const cols = t.columns.filter((c) => c.generated !== "s");
    const overriding = cols.some((c) => c.identity === "a") ? " OVERRIDING SYSTEM VALUE" : "";
    const conflict = t.pkColumns.length ? " ON CONFLICT DO NOTHING" : "";
    const maxRowsByParams = Math.floor(MAX_PARAMS / cols.length);
    const colList = cols.map((c) => qi(c.name)).join(", ");

    let read = 0;
    let inserted = 0;
    let batchCount = 0;
    for await (const rows of readPages(src, t, cols, "src")) {
        read += rows.length;
        // Split the page into batches under the row / byte / bind-parameter limits.
        const batches: Row[][] = [];
        let cur: Row[] = [];
        let curBytes = 0;
        for (const r of rows) {
            let bytes = 0;
            for (const c of cols) bytes += r[c.name] ? Buffer.byteLength(r[c.name]!) : 1;
            if (bytes > MAX_ROW_BYTES) {
                throw new Error(`${t.name}: a row is ${bytes} bytes; DSQL rows are limited to 2 MiB`);
            }
            if (
                cur.length > 0 &&
                (cur.length >= MAX_ROWS_PER_BATCH || cur.length >= maxRowsByParams || curBytes + bytes > MAX_BYTES_PER_BATCH)
            ) {
                batches.push(cur);
                cur = [];
                curBytes = 0;
            }
            cur.push(r);
            curBytes += bytes;
        }
        if (cur.length) batches.push(cur);
        batchCount += batches.length;

        let next = 0;
        const worker = async () => {
            while (next < batches.length) {
                const batch = batches[next++]!;
                const params: unknown[] = [];
                const tuples = batch.map((r) => {
                    const ph = cols.map((c) => {
                        params.push(r[c.name]);
                        // Bind as text, then cast: the value is exactly the source's text form, whatever the
                        // driver would otherwise infer for the parameter (e.g. JSON-encoding a string for jsonb).
                        return c.dstType === "text" ? `$${params.length}::text` : `$${params.length}::text::${c.dstType}`;
                    });
                    return `(${ph.join(", ")})`;
                });
                const sql = `INSERT INTO ${tq(t.name)} (${colList})${overriding} VALUES ${tuples.join(", ")}${conflict}`;
                const res = await withRetry(() => dst.query(sql, params));
                inserted += res.rowCount ?? 0;
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    }
    console.log(
        `  ${t.name.padEnd(28)} ${String(read).padStart(8)} read, ${String(inserted).padStart(8)} inserted (${batchCount} batches)` +
            (read !== inserted ? "  ← already present from a previous run" : ""),
    );
    return read;
}

async function jobStatus(dst: pg.Pool, jobId: string): Promise<string | null> {
    try {
        const r = await dst.query(`SELECT * FROM sys.jobs WHERE job_id = $1`, [jobId]);
        if (!r.rows[0]) return "unknown";
        const row = r.rows[0] as Record<string, unknown>;
        return String(row.status ?? row.state ?? "unknown").toLowerCase();
    } catch {
        return null; // sys.jobs not queryable
    }
}

/**
 * Phase 1: submit every CREATE INDEX ASYNC (fast, they run in the background on DSQL).
 * Phase 2: poll all submitted jobs together until they finish or INDEX_WAIT_MS elapses.
 */
async function createIndexes(dst: pg.Pool, indexes: Plan["indexes"]) {
    const results = { done: 0, pending: 0, failed: 0 };
    const jobs: { name: string; jobId: string }[] = [];

    console.log("  submitting...");
    for (const ix of indexes) {
        try {
            const res = await withRetry(() => dst.query(ix.ddl));
            const jobId = res.rows?.[0]?.job_id as string | undefined;
            if (jobId) {
                jobs.push({ name: ix.name, jobId });
                console.log(`  ↗ ${ix.name} (job ${jobId})`);
            } else {
                results.done++;
                console.log(`  ✔ ${ix.name} (already exists or built immediately)`);
            }
        } catch (e) {
            const msg = (e as Error).message;
            if (/already exists/i.test(msg)) {
                results.done++;
                console.log(`  ✔ ${ix.name} (already exists)`);
            } else {
                results.failed++;
                console.log(`  ✘ ${ix.name}: ${msg}\n    ${ix.ddl}`);
            }
        }
    }

    if (jobs.length) {
        console.log(`  waiting for ${jobs.length} background build(s), up to ${INDEX_WAIT_MS / 60000} min...`);
        const started = Date.now();
        let open = [...jobs];
        let lastLine = "";
        while (open.length && Date.now() - started < INDEX_WAIT_MS) {
            const still: typeof open = [];
            let unreadable = false;
            for (const j of open) {
                const st = await jobStatus(dst, j.jobId);
                if (st === null) {
                    unreadable = true;
                    break;
                }
                if (st === "completed" || st === "succeeded" || st === "success") {
                    results.done++;
                    console.log(`  ✔ ${j.name} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
                } else if (st === "failed" || st === "cancelled" || st === "canceled") {
                    results.failed++;
                    console.log(`  ✘ ${j.name}: job ${j.jobId} ${st} — SELECT * FROM sys.jobs WHERE job_id = '${j.jobId}'`);
                } else {
                    still.push(j);
                }
            }
            if (unreadable) {
                console.log("  sys.jobs is not readable; check progress later with --status");
                results.pending += open.length;
                open = [];
                break;
            }
            open = still;
            const line = `  … ${jobs.length - open.length}/${jobs.length} finished`;
            if (open.length && line !== lastLine) {
                console.log(line);
                lastLine = line;
            }
            if (open.length) await sleep(5000);
        }
        if (open.length) {
            results.pending += open.length;
            console.log(`  still building after ${INDEX_WAIT_MS / 60000} min (DSQL keeps going; check with --status):`);
            open.forEach((j) => console.log(`    ${j.name} (job ${j.jobId})`));
        }
    }
    return results;
}

async function showStatus(dst: pg.Pool, plan: Plan) {
    console.log("\nDSQL jobs (sys.jobs):");
    try {
        const jobs = await dst.query(`SELECT * FROM sys.jobs`);
        if (!jobs.rows.length) console.log("  (none)");
        for (const j of jobs.rows) console.log("  " + JSON.stringify(j));
    } catch (e) {
        console.log(`  could not read sys.jobs: ${(e as Error).message}`);
    }
    const existing = await dst.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [SCHEMA]);
    const have = new Set(existing.rows.map((r) => r.indexname));
    const missing = plan.indexes.filter((i) => !have.has(i.name));
    console.log(`\nIndexes: ${plan.indexes.length - missing.length}/${plan.indexes.length} present in DSQL`);
    missing.forEach((i) => console.log(`  missing: ${i.name}`));
}

async function dropTarget(dst: pg.Pool, plan: Plan) {
    console.log(`\nDropping migrated tables in ${SCHEMA} on DSQL (children first)...`);
    for (const p of [...plan.tables].reverse()) {
        await runDdl(dst, `DROP TABLE IF EXISTS ${tq(p.table.name)}`, `drop table ${p.table.name}`);
    }
}

/**
 * Name search no longer runs pg_trgm in the database: the app computes the same similarity in
 * TypeScript (src/domain/trigram.ts). Compare that port with Aurora's pg_trgm on real names.
 */
async function checkSimilarity(src: pg.Pool) {
    console.log(`\nName similarity: pg_trgm (Aurora) vs app port (src/domain/trigram.ts)`);
    try {
        const names: string[] = [];
        for (const table of ["leads", "users", "professors"]) {
            const r = await src.query<{ n: string }>(
                `SELECT normalized_name AS n FROM ${tq(table)} WHERE normalized_name <> '' ORDER BY random() LIMIT 400`,
            );
            names.push(...r.rows.map((row) => row.n));
        }
        if (names.length < 2) {
            console.log("  (not enough names to compare)");
            return true;
        }
        const a: string[] = [];
        const b: string[] = [];
        names.forEach((n, i) => {
            a.push(n, n, n);
            b.push(names[(i + 1) % names.length]!, n.split(" ")[0]!, n.slice(0, Math.max(3, Math.floor(n.length * 0.7))));
        });
        a.push("joao da silva", "", "ab", "maria-jose 2", "JOSÉ  d'Ávila");
        b.push("joão silva", "maria", "abc", "maria jose", "jose davila");
        const res = await src.query<{ s: number }>(
            `SELECT similarity(t.a, t.b)::float8 AS s FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(a, b, i) ORDER BY t.i`,
            [a, b],
        );
        let diff = 0;
        let matchDiff = 0;
        res.rows.forEach((r, i) => {
            const mine = trigramSimilarity(a[i]!, b[i]!);
            if (!(Math.abs(Number(r.s) - mine) < 1e-6)) {
                diff++;
                if (isTrigramMatch(Number(r.s)) !== isTrigramMatch(mine)) matchDiff++;
                if (diff <= 5) console.log(`  ≠ similarity(${ql(a[i]!)}, ${ql(b[i]!)}): pg_trgm ${r.s} / app ${mine}`);
            }
        });
        console.log(
            diff === 0
                ? `  ✔ identical on ${a.length} pairs`
                : `  ✘ ${diff}/${a.length} pairs differ (${matchDiff} would change whether a name matches)`,
        );
        return matchDiff === 0;
    } catch (e) {
        console.log(`  ✘ could not compare: ${(e as Error).message}`);
        return false;
    }
}

/** Order-independent digest of a table's content: XOR of sha256(row) + row count. */
async function tableDigest(pool: pg.Pool, t: Table, side: "src" | "dst") {
    const cols = t.columns;
    const acc = Buffer.alloc(32);
    let n = 0;
    for await (const rows of readPages(pool, t, cols, side)) {
        for (const r of rows) {
            const h = createHash("sha256");
            for (const c of cols) {
                const v = r[c.name];
                h.update(v === null || v === undefined ? "\u0000N" : `\u0001${v}`);
                h.update("\u001f");
            }
            const d = h.digest();
            for (let i = 0; i < 32; i++) acc[i] = (acc[i] ?? 0) ^ (d[i] ?? 0);
            n++;
        }
    }
    return { n, digest: acc.toString("hex") };
}

async function verify(src: pg.Pool, dst: pg.Pool, plan: Plan, withChecksums: boolean) {
    let ok = true;
    const tables = plan.tables.map((p) => p.table);

    console.log("\nObjects on DSQL:");
    const dstCols = await dst.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
        [SCHEMA],
    );
    const colsByTable = new Map<string, Set<string>>();
    for (const r of dstCols.rows) {
        if (!colsByTable.has(r.table_name)) colsByTable.set(r.table_name, new Set());
        colsByTable.get(r.table_name)!.add(r.column_name);
    }
    const dstCons = await dst.query<{ conname: string }>(
        `SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1`,
        [SCHEMA],
    );
    const haveCons = new Set(dstCons.rows.map((r) => r.conname));
    const dstIdx = await dst.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [SCHEMA]);
    const haveIdx = new Set(dstIdx.rows.map((r) => r.indexname));
    for (const p of plan.tables) {
        const have = colsByTable.get(p.table.name);
        const missingCols = p.table.columns.filter((c) => !have?.has(c.name)).map((c) => c.name);
        const missingCons = p.constraintNames.filter((c) => !haveCons.has(c));
        const missingIdx = plan.indexes.filter((i) => i.table === p.table.name && !haveIdx.has(i.name)).map((i) => i.name);
        const bad = !have || missingCols.length || missingCons.length || missingIdx.length;
        if (bad) ok = false;
        console.log(
            `  ${bad ? "✘" : "✔"} ${p.table.name.padEnd(28)} ${p.table.columns.length} cols, ${p.constraintNames.length} constraints, ` +
                `${plan.indexes.filter((i) => i.table === p.table.name).length} indexes` +
                (!have ? "  — TABLE MISSING" : "") +
                (missingCols.length ? `  — missing columns: ${missingCols.join(", ")}` : "") +
                (missingCons.length ? `  — missing constraints: ${missingCons.join(", ")}` : "") +
                (missingIdx.length ? `  — missing/building indexes: ${missingIdx.join(", ")}` : ""),
        );
    }

    console.log(`\nRow ${withChecksums ? "counts + content checksums" : "counts"} (Aurora → DSQL):`);
    for (const t of tables) {
        if (withChecksums) {
            const [a, b] = await Promise.all([
                tableDigest(src, t, "src"),
                tableDigest(dst, t, "dst").catch((e) => ({ n: -1, digest: `ERROR: ${(e as Error).message}` })),
            ]);
            const match = a.n === b.n && a.digest === b.digest;
            if (!match) ok = false;
            console.log(
                `  ${match ? "✔" : "✘"} ${t.name.padEnd(28)} ${String(a.n).padStart(8)} → ${String(b.n).padStart(8)}  ` +
                    (match ? `sha ${a.digest.slice(0, 12)}` : a.n === b.n ? "same count, CONTENT DIFFERS" : b.digest.startsWith("ERROR") ? b.digest : "count differs"),
            );
        } else {
            const a = await src.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tq(t.name)}`);
            const b = await dst
                .query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tq(t.name)}`)
                .catch((e) => ({ rows: [{ n: `ERROR: ${(e as Error).message}` }] }));
            const match = a.rows[0]!.n === b.rows[0]!.n;
            if (!match) ok = false;
            console.log(`  ${match ? "✔" : "✘"} ${t.name.padEnd(28)} ${a.rows[0]!.n.padStart(8)} → ${b.rows[0]!.n}`);
        }
    }

    if (!(await checkSimilarity(src))) ok = false;

    console.log("\nIntentionally not migrated (no DSQL equivalent):");
    console.log(`  • extensions pg_trgm, pgcrypto (gen_random_uuid() is built in; similarity() now runs in the app)`);
    console.log(`  • enum types (${[...new Set(tables.flatMap((t) => t.columns.filter((c) => c.enumType).map((c) => c.enumType)))].join(", ")}) → text + CHECK`);
    plan.skippedIndexes.forEach((s) => console.log(`  • index ${s.split(":")[0]}`));
    return ok;
}

async function preflight(src: pg.Pool, tables: Table[]) {
    console.log("\nSource tables (rows / largest row / total):");
    for (const t of tables) {
        const r = await src.query<{ n: string; maxrow: string; total: string }>(
            // octet_length of the text form = uncompressed size, which is what the 2 MiB DSQL row limit sees
            // (pg_column_size would report the TOAST-compressed size and under-warn).
            `SELECT count(*)::text AS n, coalesce(max(octet_length(x::text)), 0)::text AS maxrow,
                    pg_size_pretty(coalesce(sum(octet_length(x::text)), 0)::bigint) AS total
             FROM ${tq(t.name)} x`,
        );
        const row = r.rows[0]!;
        const big = Number(row.maxrow) > MAX_ROW_BYTES * 0.75;
        console.log(
            `  ${big ? "!" : " "} ${t.name.padEnd(28)} ${row.n.padStart(8)} rows   max row ${String(Math.round(Number(row.maxrow) / 1024)).padStart(6)} KiB   ${row.total}` +
                (big ? "  ← close to DSQL's 2 MiB row limit" : ""),
        );
    }
}

async function main() {
    const src = sourcePool();
    console.log(`Source: Aurora ${process.env.PostgreHost}  schema "${SCHEMA}"`);
    const intro = await introspect(src);
    if (!intro.tables.length) throw new Error(`No tables found in schema "${SCHEMA}" on the source.`);
    if (EXCLUDE.size) {
        intro.tables = intro.tables.filter((t) => !EXCLUDE.has(t.name));
        intro.sequences = intro.sequences.filter((s) => ![...EXCLUDE].some((t) => s.startsWith(`${t}_`)));
        console.log(`Excluding: ${[...EXCLUDE].join(", ")}`);
    }
    const plan = buildPlan(intro);
    const ordered = plan.tables.map((p) => p.table);

    console.log(
        `Found ${ordered.length} tables, ${intro.enums.size} enums, ${plan.indexes.length} B-tree indexes ` +
            `(+${plan.skippedIndexes.length} non-B-tree), ${plan.sequences.length} sequences, ${intro.functions.length} SQL functions.`,
    );
    if (plan.warnings.length) {
        console.log("\nWarnings:");
        plan.warnings.forEach((w) => console.log(`  ! ${w}`));
    }
    if (plan.blockers.length) {
        console.log("\nBlockers (fix before migrating):");
        plan.blockers.forEach((b) => console.log(`  ✘ ${b}`));
    }

    if (DRY_RUN) {
        await preflight(src, ordered);
        console.log("\n-- ===== DRY RUN: DDL that would run on DSQL =====");
        console.log(`CREATE SCHEMA IF NOT EXISTS ${S};\n`);
        plan.functions.forEach((f) => console.log(`${f};\n`));
        plan.sequences.forEach((s) => console.log(`${s};`));
        plan.tables.forEach((p) => console.log(`${p.ddl};\n`));
        plan.indexes.forEach((i) => console.log(`${i.ddl};`));
        await src.end();
        return;
    }
    if (plan.blockers.length) {
        await src.end();
        process.exit(2);
    }

    const dst = targetPool();
    console.log(`Target: DSQL ${process.env.DSQL_ENDPOINT}`);
    await dst.query("SELECT 1");

    if (STATUS_ONLY) {
        await showStatus(dst, plan);
        await src.end();
        await dst.end();
        return;
    }

    if (DROP_TARGET) await dropTarget(dst, plan);

    if (!VERIFY_ONLY && !INDEXES_ONLY) {
        console.log("\n1/4 Schema, functions and sequences");
        await runDdl(dst, `CREATE SCHEMA IF NOT EXISTS ${S}`, `schema ${SCHEMA}`);
        for (const f of plan.functions) {
            const name = f.match(/FUNCTION\s+([^\s(]+)/i)?.[1] ?? "function";
            await runDdl(dst, f, `function ${name}`);
        }
        for (const s of plan.sequences) await runDdl(dst, s, s);

        console.log("\n2/4 Tables");
        for (const p of plan.tables) await runDdl(dst, p.ddl, `table ${p.table.name}`);

        console.log("\n3/4 Data");
        const started = Date.now();
        for (const t of ordered) await copyTable(src, dst, t);
        console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

        // Advance sequences past copied values.
        for (const s of intro.sequences) {
            const v = await src.query<{ last_value: string; is_called: boolean }>(
                `SELECT last_value::text, is_called FROM ${tq(s)}`,
            );
            const r = v.rows[0]!;
            await withRetry(() => dst.query(`SELECT setval($1::regclass, $2::bigint, $3)`, [tq(s), r.last_value, r.is_called]));
            console.log(`  sequence ${s} -> ${r.last_value}`);
        }
    }

    if (!VERIFY_ONLY && (INDEXES_ONLY || !SKIP_INDEXES)) {
        console.log(`\n4/4 Indexes (CREATE INDEX ASYNC, ${plan.indexes.length})`);
        const results = await createIndexes(dst, plan.indexes);
        console.log(`  indexes: ${results.done} done, ${results.pending} still building, ${results.failed} failed`);
    }

    const ok = await verify(src, dst, plan, true);
    await src.end();
    await dst.end();
    console.log(
        ok
            ? "\nMigration verified: every table, column, constraint and index is present and every row matches byte for byte."
            : "\nVerification found differences — see ✘ / ! lines above.",
    );
    if (!ok) process.exit(1);
}

main().catch((e) => {
    console.error("\nMigration failed:", e);
    process.exit(1);
});
