import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Navigation } from "@/components/ui/navigation";
import { Link } from "react-router-dom";
import { User } from "@supabase/supabase-js";

type SignupPlan = {
  id: string;
  name: string;
  event_url: string;
  signup_time: string;
  status: string;
  created_at: string;
};

export default function Dashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [plans, setPlans] = useState<SignupPlan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      
      if (user) {
        // Fetch user's signup plans
        const { data: plansData } = await supabase
          .from('signup_plans')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });
        
        if (plansData) {
          setPlans(plansData);
        }
      }
      setLoading(false);
    };

    getUser();
  }, []);

  if (loading) {
    return (
      <div>
        <Navigation />
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">Loading...</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div>
        <Navigation />
        <div className="container mx-auto px-4 py-12">
          <div className="text-center max-w-2xl mx-auto">
            <h1 className="text-4xl font-bold mb-4">Welcome to SignupAssist</h1>
            <p className="text-xl text-muted-foreground mb-8">
              Automate your event signups with intelligent browser automation
            </p>
            <div className="space-x-4">
              <Link to="/login">
                <Button size="lg">Get Started</Button>
              </Link>
              <Link to="/signup">
                <Button variant="outline" size="lg">Sign Up</Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Navigation />
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Dashboard</h1>
            <p className="text-muted-foreground">Manage your automated signups</p>
          </div>
          <Button>
            + New Signup Plan
          </Button>
        </div>

        {plans.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <h3 className="text-lg font-semibold mb-2">No signup plans yet</h3>
              <p className="text-muted-foreground mb-4">
                Create your first automated signup plan to get started
              </p>
              <Button>Create First Plan</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {plans.map((plan) => (
              <Card key={plan.id}>
                <CardHeader>
                  <CardTitle className="flex justify-between">
                    {plan.name}
                    <span className={`text-sm px-2 py-1 rounded ${
                      plan.status === 'active' ? 'bg-green-100 text-green-800' :
                      plan.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {plan.status}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-2">
                    Event: {plan.event_url}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Scheduled: {new Date(plan.signup_time).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}