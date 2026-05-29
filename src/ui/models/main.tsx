import React from "react";
import { createRoot } from "react-dom/client";
import { Models } from "./Models";
import "../shared/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <React.StrictMode>
    <Models />
  </React.StrictMode>,
);
