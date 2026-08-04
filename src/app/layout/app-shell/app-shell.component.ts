import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { SidebarComponent } from "../sidebar/sidebar.component";
import { StatusBarComponent } from "../status-bar/status-bar.component";
import { TopbarComponent } from "../topbar/topbar.component";

@Component({
  selector: "app-shell",
  imports: [RouterOutlet, SidebarComponent, StatusBarComponent, TopbarComponent],
  templateUrl: "./app-shell.component.html",
  styleUrl: "./app-shell.component.css",
})
export class AppShellComponent {}
