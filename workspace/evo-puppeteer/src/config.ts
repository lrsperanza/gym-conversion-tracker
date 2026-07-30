export const LOGIN_URL =
  'https://evo5.w12app.com.br/#/acesso/skyfitacademia/autenticacao';

/** O formulário de novo cadastro vive dentro deste drawer lateral. */
export const DRAWER = 'evo-drawer#cadastroDrawer';

export const SELECTORS = {
  login: {
    usuario: 'input#usuario',
    senha: 'input#senha',
    entrar: 'evo-button#entrar button',
  },
  unidade: {
    modal: 'modal-login-multiunidade',
    dialog: 'mat-dialog-container',
    card: '[class*="card-login"]',
    confirmar: 'mat-dialog-container button',
  },
  novoCadastro: 'button#atalhoNovoCadastro',
  cadastro: {
    nome: `${DRAWER} input#nome`,
    sobrenome: `${DRAWER} input#snome`,
    cpf: `${DRAWER} input#cpf`,
    nascimento: `${DRAWER} input#dtNascimento`,
    cep: `${DRAWER} input#cep`,
    telefone: `${DRAWER} evo-phone input[placeholder*="Celular"]`,
    email: `${DRAWER} input#email`,
    genero: 'sexo',
    tipoVisita: 'tipoVisita',
    comoConheceu: 'prospectMarketing',
  },
} as const;

export type Prospect = {
  nome: string;
  sobrenome: string;
  cpf: string;
  nascimento: string;
  genero: string;
  cep: string;
  telefone: string;
  email: string;
  tipoVisita: string;
  comoConheceu: string;
};

export const DEFAULT_PROSPECT: Prospect = {
  nome: 'aluno 1',
  sobrenome: 'sobrenome 1',
  cpf: '41946265837',
  nascimento: '01/04/1994',
  genero: 'Masculino',
  cep: '14801150',
  telefone: '16996123434',
  email: 'lrsperanza@gmail.com',
  tipoVisita: 'Pessoal',
  comoConheceu: 'Veio até academia',
};

export const DEFAULT_UNIDADE = 'Vila Xavier';
