import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { User, Session } from "@supabase/supabase-js";
import LoginRegister from "./LoginRegister";

interface AuthGateProps {
  children: React.ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Debug logging
    console.log('Supabase client:', supabase);
    console.log('Supabase auth:', supabase?.auth);
    console.log('getSession method:', typeof supabase?.auth?.getSession);
    
    if (!supabase || !supabase.auth || typeof supabase.auth.getSession !== 'function') {
      console.error('Supabase client is not properly configured');
      setLoading(false);
      return;
    }

    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      
      if (session?.user && location.pathname === "/") {
        navigate("/dashboard");
      } else if (!session?.user && location.pathname !== "/" && location.pathname !== "/verify") {
        navigate("/");
      }
    });

    // THEN check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);

      // If user is signed in and on root path, redirect to dashboard
      if (session?.user && location.pathname === "/") {
        navigate("/dashboard");
      }
    }).catch((error) => {
      console.error('Error getting session:', error);
      setLoading(false);
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

  // If trying to access protected routes without auth, redirect to login
  if (!user && !["/", "/login", "/signup"].includes(location.pathname) && !location.pathname.startsWith("/verify")) {
    return <LoginRegister />;
  }

  // If signed in, show children
  if (user) {
    return <>{children}</>;
  }

  // Fallback
  return <LoginRegister />;
}