import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { CreateTagRequest } from "../../../core/models/tag.model";
import { TranslatePipe } from "../../pipes/translate.pipe";

@Component({
  selector: "app-tag-dialog",
  imports: [FormsModule, TranslatePipe],
  templateUrl: "./tag-dialog.component.html",
  styleUrl: "./tag-dialog.component.css",
})
export class TagDialogComponent implements AfterViewInit {
  @ViewChild("dialog", { static: true }) dialog!: ElementRef<HTMLDialogElement>;
  @ViewChild("nameInput") nameInput?: ElementRef<HTMLInputElement>;

  @Input() commitHash?: string;
  @Input() shortHash?: string;
  @Input() isSaving = false;

  @Output() confirmed = new EventEmitter<CreateTagRequest>();
  @Output() cancelled = new EventEmitter<void>();

  readonly tagName = signal("");
  readonly tagMessage = signal("");
  readonly pushImmediately = signal(false);
  readonly errorMessage = signal("");

  ngAfterViewInit(): void {
    this.dialog.nativeElement.showModal();
    setTimeout(() => this.nameInput?.nativeElement.focus(), 50);
  }

  onCancel(event: Event): void {
    event.preventDefault();
    if (!this.isSaving) {
      this.cancelled.emit();
    }
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget && !this.isSaving) {
      this.cancelled.emit();
    }
  }

  submit(): void {
    const name = this.tagName().trim();
    if (!name) {
      this.errorMessage.set("Informe o nome da tag.");
      return;
    }

    if (name.includes(" ") || name.includes("~") || name.includes("^") || name.includes(":")) {
      this.errorMessage.set("O nome da tag não pode conter espaços ou caracteres especiais (~, ^, :).");
      return;
    }

    this.errorMessage.set("");
    this.confirmed.emit({
      name,
      commitHash: this.commitHash,
      message: this.tagMessage().trim() || undefined,
      push: this.pushImmediately(),
    });
  }
}
