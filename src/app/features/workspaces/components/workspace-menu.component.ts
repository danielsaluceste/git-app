import { Component, ElementRef, HostListener, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { Workspace } from "../../../core/models/workspace.model";
import { LayoutService } from "../../../core/services/layout.service";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { WorkspaceService } from "../../../core/services/workspace.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";

@Component({
  selector: "app-workspace-menu",
  imports: [ConfirmDialogComponent, FormsModule],
  templateUrl: "./workspace-menu.component.html",
  styleUrl: "./workspace-menu.component.css",
})
export class WorkspaceMenuComponent {
  private readonly workspaceService = inject(WorkspaceService);
  private readonly layoutService = inject(LayoutService);
  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);
  readonly workspaces = this.workspaceService.workspaces;
  readonly activeWorkspace = this.workspaceService.activeWorkspace;

  isOpen = false;
  isFormOpen = false;
  editingId: string | null = null;
  formName = "";
  formDescription = "";
  formError = "";
  workspaceToDelete: Workspace | null = null;

  toggleMenu(): void {
    this.isOpen = !this.isOpen;

    if (!this.isOpen) {
      this.resetForm();
    }
  }

  @HostListener("document:click", ["$event"])
  closeOnOutsideClick(event: MouseEvent): void {
    if (!this.isOpen) {
      return;
    }

    const target = event.target as Node | null;
    if (target && this.elementRef.nativeElement.contains(target)) {
      return;
    }

    this.isOpen = false;
    this.resetForm();
  }

  selectWorkspace(id: string): void {
    const changedWorkspace = id !== this.activeWorkspace().id;
    this.workspaceService.select(id);
    this.isOpen = false;
    this.resetForm();

    if (changedWorkspace) {
      this.repositoryService.setActive(undefined);
      this.layoutService.openMainSidebar();
      void this.router.navigate(["/repositories"]);
    }
  }

  startCreate(): void {
    this.isOpen = true;
    this.isFormOpen = true;
    this.editingId = null;
    this.formName = "";
    this.formDescription = "";
    this.formError = "";
  }

  startEdit(workspace: Workspace): void {
    this.isOpen = true;
    this.isFormOpen = true;
    this.editingId = workspace.id;
    this.formName = workspace.name;
    this.formDescription = workspace.description;
    this.formError = "";
  }

  cancelForm(): void {
    this.resetForm();
  }

  saveWorkspace(): void {
    if (!this.formName.trim()) {
      this.formError = "Informe um nome para o workspace.";
      return;
    }

    const saved = this.editingId
      ? this.workspaceService.update(this.editingId, this.formName, this.formDescription)
      : this.workspaceService.create(this.formName, this.formDescription);

    if (!saved) {
      this.formError = "Não foi possível salvar o workspace.";
      return;
    }

    this.toastService.success(
      this.editingId ? "Workspace atualizado com sucesso." : "Workspace criado com sucesso.",
      this.editingId ? "Workspace atualizado" : "Workspace criado",
    );
    this.resetForm();
  }

  removeWorkspace(workspace: Workspace): void {
    if (this.workspaces().length <= 1) {
      this.formError = "Mantenha pelo menos um workspace.";
      return;
    }

    this.workspaceToDelete = workspace;
  }

  confirmRemoveWorkspace(): void {
    if (!this.workspaceToDelete) {
      return;
    }

    this.workspaceService.remove(this.workspaceToDelete.id);
    this.toastService.success("Workspace excluído. Os repositórios foram preservados.", "Workspace excluído");
    this.workspaceToDelete = null;
    this.isOpen = false;
    this.resetForm();
  }

  cancelRemoveWorkspace(): void {
    this.workspaceToDelete = null;
  }

  private resetForm(): void {
    this.isFormOpen = false;
    this.editingId = null;
    this.formName = "";
    this.formDescription = "";
    this.formError = "";
  }
}
