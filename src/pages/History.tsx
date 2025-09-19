import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Calendar, Target, DollarSign, X, Edit } from "lucide-react";
import Header from "@/components/Header";
import EditPlanModal from "@/components/EditPlanModal";
import { useToast } from "@/hooks/use-toast";

interface Plan {
  id: string;
  org: string;
  preferred: string;
  alternate?: string;
  open_time: string;
  status: string;
  paid: boolean;
  created_at: string;
  base_url: string;
  child_name: string;
  phone?: string;
  extras?: any;
}

export default function History() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    loadPlans();
  }, []);

  const loadPlans = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        navigate("/");
        return;
      }

      const { data, error } = await supabase
        .from('plans')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      console.log('Loaded plans:', data);
      data?.forEach(plan => {
        console.log(`Plan ${plan.id}: status=${plan.status}, should show edit: ${plan.status !== 'executing' && plan.status !== 'running'}`);
      });
      setPlans(data || []);
    } catch (error) {
      console.error('Error loading plans:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load plan history"
      });
    } finally {
      setLoading(false);
    }
  };

  const cancelPlan = async (planId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent card click navigation
    
    try {
      const { error } = await supabase
        .from('plans')
        .update({ status: 'cancelled' })
        .eq('id', planId);

      if (error) throw error;

      // Add a log entry
      await supabase.from('plan_logs').insert({
        plan_id: planId,
        msg: 'Plan cancelled by user'
      });

      toast({
        title: "Success",
        description: "Plan cancelled successfully"
      });

      // Reload the plans to show updated status
      loadPlans();
    } catch (error) {
      console.error('Error cancelling plan:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to cancel plan"
      });
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
      case 'alt_success':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'action_required':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'error':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'scheduled':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'running':
      case 'executing':
        return 'bg-purple-100 text-purple-800 border-purple-200';
      case 'cancelled':
        return 'bg-gray-100 text-gray-800 border-gray-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'success':
        return 'Success';
      case 'alt_success':
        return 'Alt Success';
      case 'action_required':
        return 'Action Required';
      case 'error':
        return 'Error';
      case 'scheduled':
        return 'Scheduled';
      case 'running':
      case 'executing':
        return 'Running';
      case 'cancelled':
        return 'Cancelled';
      default:
        return status;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatOpenTime = (openTimeString: string) => {
    return new Date(openTimeString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handlePlanClick = (planId: string) => {
    navigate(`/history/${planId}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center h-64">
            <div className="text-lg">Loading history...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-8">
          <Clock className="h-8 w-8 text-primary" />
          <h1 className="text-3xl font-bold">Plan History</h1>
        </div>

        {plans.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground mb-4">No plans found</p>
              <Button onClick={() => navigate('/plan')}>
                Create Your First Plan
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {plans.map((plan) => (
              <Card 
                key={plan.id} 
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => handlePlanClick(plan.id)}
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{plan.org}</CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge className={getStatusColor(plan.status)}>
                        {getStatusText(plan.status)}
                      </Badge>
                      {(plan.status === 'success' || plan.status === 'alt_success') && (
                        <Badge variant={plan.paid ? "default" : "destructive"}>
                          {plan.paid ? "Paid" : "Unpaid"}
                        </Badge>
                      )}
                      {/* Edit button available for most statuses */}
                      {(() => {
                        const shouldShow = plan.status !== 'executing' && plan.status !== 'running';
                        console.log(`Plan ${plan.org}: status="${plan.status}", shouldShowEdit=${shouldShow}`);
                        return shouldShow;
                      })() && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingPlan(plan);
                          }}
                        >
                          <Edit className="h-4 w-4 mr-1" />
                          Edit
                        </Button>
                      )}
                      {/* Debug indicator */}
                      <span className="text-xs text-muted-foreground">
                        Status: {plan.status}
                      </span>
                      {/* Cancel button only for scheduled plans */}
                      {plan.status === 'scheduled' && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={(e) => cancelPlan(plan.id, e)}
                        >
                          <X className="h-4 w-4 mr-1" />
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <Target className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">Slot:</span>
                      <span>{plan.preferred}</span>
                      {plan.alternate && (
                        <span className="text-muted-foreground">
                          (alt: {plan.alternate})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">Open:</span>
                      <span>{formatOpenTime(plan.open_time)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">Created:</span>
                      <span>{formatDate(plan.created_at)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {editingPlan && (
          <EditPlanModal
            plan={editingPlan}
            open={!!editingPlan}
            onClose={() => setEditingPlan(null)}
            onSuccess={loadPlans}
          />
        )}
      </div>
    </div>
  );
}