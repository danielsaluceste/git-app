import { Component, ElementRef, HostListener, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { Workspace } from "../../../core/models/workspace.model";
import { LayoutService } from "../../../core/services/layout.service";
import { RepositoryService } from "../../../core/services/repository.service";
import { ToastService } from "../../../core/services/toast.service";
import { TranslationService } from "../../../core/services/translation.service";
import { WorkspaceService } from "../../../core/services/workspace.service";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { TranslatePipe } from "../../../shared/pipes/translate.pipe";

@Component({
  selector: "app-workspace-menu",
  imports: [ConfirmDialogComponent, FormsModule, TranslatePipe],
  templateUrl: "./workspace-menu.component.html",
  styleUrl: "./workspace-menu.component.css",
})
export class WorkspaceMenuComponent {
  private readonly workspaceService = inject(WorkspaceService);
  private readonly layoutService = inject(LayoutService);
  private readonly repositoryService = inject(RepositoryService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);
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
      this.formError = this.translationService.translate("workspace.requiredName");
      return;
    }

    const saved = this.editingId
      ? this.workspaceService.update(this.editingId, this.formName, this.formDescription)
      : this.workspaceService.create(this.formName, this.formDescription);

    if (!saved) {
      this.formError = this.translationService.translate("workspace.saveError");
      return;
    }

    this.toastService.success(
      this.translationService.translate(this.editingId ? "workspace.updatedMessage" : "workspace.createdMessage"),
      this.translationService.translate(this.editingId ? "workspace.updatedTitle" : "workspace.createdTitle"),
    );
    this.resetForm();
  }

  removeWorkspace(workspace: Workspace): void {
    if (this.workspaces().length <= 1) {
      this.formError = this.translationService.translate("workspace.keepOne");
      return;
    }

    this.workspaceToDelete = workspace;
  }

  confirmRemoveWorkspace(): void {
    if (!this.workspaceToDelete) {
      return;
    }

    this.workspaceService.remove(this.workspaceToDelete.id);
    this.toastService.success(
      this.translationService.translate("workspace.deletedMessage"),
      this.translationService.translate("workspace.deletedTitle"),
    );
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
