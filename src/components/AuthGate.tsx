import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { User } from "@supabase/supabase-js";
import LoginRegister from "./LoginRegister";

interface AuthGateProps {
  children: React.ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Get initial session
    const getSession = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      setLoading(false);

      // If user is signed in and on root path, redirect to dashboard
      if (user && location.pathname === "/") {
        navigate("/dashboard");
      }
    };

    getSession();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      
      if (session?.user && location.pathname === "/") {
        navigate("/dashboard");
      } else if (!session?.user && location.pathname === "/dashboard") {
        navigate("/");
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate, location.pathname]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">Loading...</div>
      </div>
    );
  }

  // If on root path and not signed in, show login/register
  if (location.pathname === "/" && !user) {
    return <LoginRegister />;
  }

  // If on dashboard and not signed in, redirect handled by useEffect
  if (location.pathname === "/dashboard" && !user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">Redirecting...</div>
      </div>
    );
  }

  // If signed in, show children
  if (user) {
    return <>{children}</>;
  }

  // Fallback
  return <LoginRegister />;
}