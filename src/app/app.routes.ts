import { Routes } from "@angular/router";
import { HistoryPageComponent } from "./features/history/pages/history-page.component";
import { AppShellComponent } from "./layout/app-shell/app-shell.component";
import { BranchesPageComponent } from "./features/branches/pages/branches-page.component";
import { ChangesPageComponent } from "./features/changes/pages/changes-page.component";
import { IntegrationsPageComponent } from "./features/integrations/pages/integrations-page.component";
import { RepositoriesPageComponent } from "./features/repositories/pages/repositories-page.component";
import { RepositorySettingsPageComponent } from "./features/repository-settings/pages/repository-settings-page.component";
import { SettingsPageComponent } from "./features/settings/pages/settings-page.component";

export const routes: Routes = [
  {
    path: "",
    component: AppShellComponent,
    children: [
      { path: "", redirectTo: "repositories", pathMatch: "full" },
      { path: "repositories", component: RepositoriesPageComponent },
      { path: "integrations", component: IntegrationsPageComponent },
      { path: "changes", component: ChangesPageComponent },
      {
        path: "stashes",
        loadComponent: () =>
          import("./features/stashes/pages/stashes-page.component").then(
            (module) => module.StashesPageComponent,
          ),
      },
  {
    path: "overview",
    component: HistoryPageComponent,
  },
      { path: "history", redirectTo: "overview", pathMatch: "full" },
      { path: "branches", component: BranchesPageComponent },
      {
        path: "terminal",
        loadComponent: () =>
          import("./features/terminal/pages/terminal-page.component").then(
            (module) => module.TerminalPageComponent,
          ),
      },
      { path: "repository-settings", component: RepositorySettingsPageComponent },
      { path: "settings", component: SettingsPageComponent },
    ],
  },
  { path: "**", redirectTo: "repositories" },
];
