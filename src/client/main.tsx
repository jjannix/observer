import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./theme.css";
import { App } from "./App.js";
import { Overview } from "./routes/overview.js";
import { Sessions } from "./routes/sessions.js";
import { Analysis } from "./routes/analysis.js";
import { Settings } from "./routes/settings.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 5_000, retry: 1 },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Overview />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="analysis" element={<Analysis />} />
            <Route path="events" element={<Navigate to="/sessions" replace />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
