export interface GitTag {
  name: string;
  commitHash: string;
  shortHash: string;
  message: string;
  taggerName: string;
  taggerEmail: string;
  date: string;
  isAnnotated: boolean;
}

export interface CreateTagRequest {
  name: string;
  commitHash?: string;
  message?: string;
  push: boolean;
}
