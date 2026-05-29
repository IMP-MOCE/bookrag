import React from "react";
import { createRoot } from "react-dom/client";
import { Options } from "./Options";
import "../shared/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
);
