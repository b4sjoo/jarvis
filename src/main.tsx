import React from "react";
import ReactDOM from "react-dom/client";
import MossApp from "@/pages/app";
import "./global.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MossApp />
  </React.StrictMode>
);
