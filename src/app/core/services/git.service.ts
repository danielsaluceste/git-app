import { Injectable } from "@angular/core";
import { TauriCommandsService } from "../tauri/tauri-commands.service";

@Injectable({ providedIn: "root" })
export class GitService {
  constructor(private readonly tauriCommands: TauriCommandsService) {}

  command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
    return this.tauriCommands.execute<T>(name, args);
  }
}
