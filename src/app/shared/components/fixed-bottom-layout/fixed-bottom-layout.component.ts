import { Component, Input } from "@angular/core";

@Component({
  selector: "app-fixed-bottom-layout",
  templateUrl: "./fixed-bottom-layout.component.html",
  styleUrl: "./fixed-bottom-layout.component.css",
})
export class FixedBottomLayoutComponent {
  @Input() bleed = false;
}
