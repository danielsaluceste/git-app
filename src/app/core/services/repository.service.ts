import { Injectable } from "@angular/core";
import { Repository } from "../models/repository.model";

@Injectable({ providedIn: "root" })
export class RepositoryService {
  private activeRepository?: Repository;

  getActive(): Repository | undefined {
    return this.activeRepository;
  }

  setActive(repository: Repository | undefined): void {
    this.activeRepository = repository;
  }
}
