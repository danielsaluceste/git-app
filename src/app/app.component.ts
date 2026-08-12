import { Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { ThemeService } from "./core/services/theme.service";

@Component({
  selector: "app-root",
  imports: [RouterOutlet],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  // Instancia o serviço na inicialização para aplicar o tema antes do shell aparecer.
  private readonly themeService = inject(ThemeService);

  constructor() {
    // A janela Tauri usa transparência para a moldura projetar a sombra para fora.
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      document.documentElement.dataset["tauriWindow"] = "true";
    }
  }
}
