import { registerRoot } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { RemotionRoot } from "./Root";
import "./styles.css";

loadFont("normal", {
  weights: ["400", "500", "600", "700", "800", "900"],
  subsets: ["latin"],
});
loadMono("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

registerRoot(RemotionRoot);
