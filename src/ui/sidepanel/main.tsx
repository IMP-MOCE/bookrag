import React from "react";
import { createRoot } from "react-dom/client";
import { Sidepanel } from "./Sidepanel";
import "../shared/styles.css";
import "./sidepanel.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <React.StrictMode>
    <Sidepanel />
  </React.StrictMode>,
);
