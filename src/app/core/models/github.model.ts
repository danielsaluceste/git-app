export interface GithubUser {
  id: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  htmlUrl: string;
}

export interface GithubConnection extends GithubUser {
  workspaceId: string;
  connectedAt: string;
  isDefault: boolean;
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
