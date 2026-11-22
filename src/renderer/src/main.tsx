import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DevCheck } from "./DevCheck.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevCheck />
  </StrictMode>,
);
