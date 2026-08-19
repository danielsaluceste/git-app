import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from "@angular/core";
import { provideRouter, RouteReuseStrategy } from "@angular/router";

import { routes } from "./app.routes";
import { AppRouteReuseStrategy } from "./core/strategies/app-route-reuse-strategy";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    { provide: RouteReuseStrategy, useClass: AppRouteReuseStrategy },
  ],
};
