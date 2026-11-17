import { useEffect, useState } from "react";
import { ProvidersTab } from "./modelhub/ProvidersTab";
import { ModelsTab } from "./modelhub/ModelsTab";
import { api } from "../api";

export function ModelHub() {
  const initialTab = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab");
  const [tab, setTab] = useState<"providers" | "models">(initialTab === "models" ? "models" : "providers");
  const [providerCount, setProviderCount] = useState(0);

  useEffect(() => {
    api.get<{ providers: unknown[] }>("/api/v1/providers").then((r) => setProviderCount(r.providers.length)).catch(() => undefined);
  }, [tab]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Model Hub</div>
          <div className="page-sub">Register providers and models — no catalogs are preloaded, nothing is phoned in.</div>
        </div>
        <div className="row">
          <button className={`btn${tab === "providers" ? " btn-primary" : ""}`} onClick={() => setTab("providers")}>Providers</button>
          <button className={`btn${tab === "models" ? " btn-primary" : ""}`} onClick={() => setTab("models")}>Models</button>
        </div>
      </div>
      {tab === "providers" ? <ProvidersTab /> : <ModelsTab providerCount={providerCount} />}
    </div>
  );
}
