import React from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AuthGate from "@/components/AuthGate";
import Auth from "@/pages/Auth";
import Dashboard from "@/pages/Dashboard";
import Credentials from "@/pages/Credentials";
import Plan from "@/pages/Plan";
import History from "@/pages/History";
import PlanDetail from "@/pages/PlanDetail";
import Verify from "@/pages/Verify";
import NotFound from "./pages/NotFound";
import { queryClient } from "@/lib/query-client";

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<AuthGate><div /></AuthGate>} />
          <Route path="/login" element={<Auth />} />
          <Route path="/signup" element={<Auth />} />
          <Route path="/dashboard" element={<AuthGate><Dashboard /></AuthGate>} />
          <Route path="/credentials" element={<AuthGate><Credentials /></AuthGate>} />
          <Route path="/plan" element={<AuthGate><Plan /></AuthGate>} />
          <Route path="/history" element={<AuthGate><History /></AuthGate>} />
          <Route path="/history/:planId" element={<AuthGate><PlanDetail /></AuthGate>} />
          <Route path="/verify/:token" element={<Verify />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
