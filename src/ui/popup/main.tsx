import React from "react";
import { createRoot } from "react-dom/client";
import { Popup } from "./Popup";
import "../shared/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
