import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { User } from "@supabase/supabase-js";

export default function Header() {
  const [user, setUser] = useState<User | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // Get initial user
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/");
  };

  return (
    <header className="border-b bg-background">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            <h1 className="text-xl font-bold text-primary">SignupAssist</h1>
          </div>
          
          <div className="flex items-center space-x-4">
            {user && (
              <>
                <Button 
                  variant="ghost" 
                  onClick={() => navigate('/dashboard')}
                  className="text-sm"
                >
                  Dashboard
                </Button>
                <Button 
                  variant="ghost" 
                  onClick={() => navigate('/history')}
                  className="text-sm"
                >
                  History
                </Button>
                <span className="text-sm text-muted-foreground">
                  {user.email}
                </span>
                <Button variant="outline" onClick={handleLogout}>
                  Logout
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}