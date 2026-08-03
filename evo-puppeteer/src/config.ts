export const LOGIN_URL =
  'https://evo-abc-2.w12app.com.br/#/acesso/skyfitacademia/autenticacao'
  //'https://evo5.w12app.com.br/#/app/skyfitacademia/320/clientes/2054580//perfil';

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
    /** O modal já apareceu como componente próprio e como mat-dialog; a busca
     * usa a primeira raiz que estiver visível na tela. */
    raizes: ['modal-login-multiunidade', 'mat-dialog-container', '.cdk-overlay-container'],
    /** Rótulos aceitos no botão que confirma a unidade escolhida. */
    confirmar: ['entrar', 'confirmar', 'acessar', 'selecionar', 'continuar'],
  },
  sessaoAtiva: 'button#atalhoNovoCadastro',
  novoCadastro: 'button#atalhoNovoCadastro',
  cadastro: {
    nome: `${DRAWER} input#nome`,
    sobrenome: `${DRAWER} input#snome`,
    cpf: `${DRAWER} input#cpf`,
    nascimento: `${DRAWER} input#dtNascimento`,
    cep: `${DRAWER} input#cep`,
    /** O telefone vem partido em dois: um select para o DDI e o número com DDD. */
    ddi: `${DRAWER} evo-phone mat-select`,
    telefone: `${DRAWER} evo-phone input[placeholder*="Celular"]`,
    email: `${DRAWER} input#email`,
    genero: 'sexo',
    tipoVisita: 'tipoVisita',
    comoConheceu: 'prospectMarketing',
  },
} as const;

/** Só o nome é obrigatório: o que vier em branco fica intocado no EVO. */
export type Prospect = {
  nome: string;
  sobrenome?: string;
  cpf?: string;
  nascimento?: string;
  genero?: string;
  cep?: string;
  /** Só os dígitos do código do país; sem isso o telefone é lido como brasileiro. */
  ddi?: string;
  telefone?: string;
  email?: string;
  tipoVisita?: string;
  comoConheceu?: string;
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
