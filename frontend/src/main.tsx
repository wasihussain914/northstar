import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./styles.css";
import App from "./App";
import GlyphsApp from "./glyphs/App";

const isGlyphs = window.location.hash === "#glyphs";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isGlyphs ? <GlyphsApp /> : <App />}
  </StrictMode>,
);
