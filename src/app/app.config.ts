import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from "@angular/core";
import { provideRouter, withViewTransitions } from "@angular/router";

import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(
      routes,
      withViewTransitions({
        onViewTransitionCreated: ({ transition }) => {
          // O glass usa uma superfície persistente no shell. O crossfade nativo
          // do Angular captura essa superfície junto com cada rota e compõe as
          // duas capturas, causando o flash/escurecimento durante a navegação.
          // A rota glass tem sua própria animação de entrada em CSS.
          if (
            typeof document !== "undefined" &&
            document.documentElement.dataset["theme"] === "glassmorphism"
          ) {
            transition.skipTransition();
          }
        },
      }),
    ),
  ],
};
