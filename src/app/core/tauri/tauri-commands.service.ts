import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

@Injectable({ providedIn: "root" })
export class TauriCommandsService {
  execute<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(command, args);
  }
}
