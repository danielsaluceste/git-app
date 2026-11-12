export interface SshKey {
  path: string;
  publicKeyPath: string;
  name: string;
  keyType: string;
  bits?: number;
  fingerprint?: string;
  comment?: string;
  publicKey: string;
  hasPrivateKey: boolean;
}

export interface SshKeyList {
  directory: string;
  keys: SshKey[];
}

export type SshConnectionTestStatus =
  | "authenticated"
  | "permissionDenied"
  | "network"
  | "error";

export interface SshConnectionTest {
  status: SshConnectionTestStatus;
  login?: string;
  message?: string;
}

export interface SshConnection {
  workspaceId: string;
  keyPath: string;
  keyName: string;
  fingerprint?: string;
  publicKey: string;
  connectedAt: string;
  login?: string;
}
