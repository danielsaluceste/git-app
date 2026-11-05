export interface GithubUser {
  id: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  htmlUrl: string;
}

/**
 * Como a conexão foi criada: pelo GitHub App (token guardado no keyring) ou
 * por uma chave SSH do computador (nenhum token é guardado).
 */
export type GithubConnectionMode = "app" | "ssh";

export interface GithubSshDetails {
  /** Caminho da chave privada; ausente quando a configuração SSH do computador é usada. */
  keyPath?: string;
  keyName?: string;
  algorithm?: string;
  /** Indica se a chave foi gerada pelo próprio GitLuna. */
  managed: boolean;
}

export interface GithubConnection extends GithubUser {
  workspaceId: string;
  connectedAt: string;
  isDefault: boolean;
  mode: GithubConnectionMode;
  ssh?: GithubSshDetails;
}

export interface GithubSshKey {
  name: string;
  path: string;
  publicKey: string;
  algorithm: string;
  managed: boolean;
}

export interface GithubSshProbe {
  authenticated: boolean;
  login?: string;
  message: string;
}

export interface GithubDeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface GithubDeviceFlowPoll {
  status: "pending" | "slowDown" | "authorized" | "denied" | "expired" | "disabled" | "error";
  user?: GithubUser;
  interval?: number;
  message?: string;
}

export interface GithubRepository {
  id: number;
  name: string;
  fullName: string;
  description?: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  ownerLogin: string;
}
