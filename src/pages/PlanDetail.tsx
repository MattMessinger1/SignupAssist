import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ExternalLink, DollarSign, Calendar, Target, Clock, X } from "lucide-react";
import Header from "@/components/Header";
import LiveLog from "@/components/LiveLog";
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
}

export default function PlanDetail() {
  const { planId } = useParams<{ planId: string }>();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (planId) {
      loadPlan();
    }
  }, [planId]);

  const loadPlan = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        navigate("/");
        return;
      }

      const { data, error } = await supabase
        .from('plans')
        .select('*')
        .eq('id', planId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;
      
      if (!data) {
        toast({
          variant: "destructive",
          title: "Plan not found",
          description: "The requested plan could not be found"
        });
        navigate('/history');
        return;
      }

      setPlan(data);
    } catch (error) {
      console.error('Error loading plan:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load plan details"
      });
      navigate('/history');
    } finally {
      setLoading(false);
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

  const cancelPlan = async () => {
    if (!plan) return;
    
    try {
      const { error } = await supabase
        .from('plans')
        .update({ status: 'cancelled' })
        .eq('id', plan.id);

      if (error) throw error;

      // Add a log entry
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: 'Plan cancelled by user'
      });

      toast({
        title: "Success",
        description: "Plan cancelled successfully"
      });

      // Reload the plan to show updated status
      loadPlan();
    } catch (error) {
      console.error('Error cancelling plan:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to cancel plan"
      });
    }
  };

  const testExecution = async () => {
    if (!plan) return;
    
    try {
      toast({
        title: "Testing Execution",
        description: "Attempting to execute plan for testing..."
      });

      const { data, error } = await supabase.functions.invoke('run-plan', {
        body: { plan_id: plan.id }
      });

      if (error) {
        console.error('Execution error:', error);
        
        // Extract detailed error information
        let errorDetails = error.message;
        if (error.context?.body) {
          try {
            const errorBody = typeof error.context.body === 'string' 
              ? JSON.parse(error.context.body) 
              : error.context.body;
            
            if (errorBody.code && errorBody.msg) {
              errorDetails = `${errorBody.code}: ${errorBody.msg}`;
              console.log('Error details:', errorBody.details);
            }
          } catch (parseError) {
            console.log('Could not parse error response:', error.context.body);
          }
        }
        
        toast({
          variant: "destructive",
          title: "Execution Failed",
          description: errorDetails
        });
        return;
      }

      if (data && !data.ok) {
        const errorDetails = data.code 
          ? `${data.code}: ${data.msg}` 
          : data.msg || 'Unknown execution error';
        
        toast({
          variant: "destructive",
          title: "Execution Failed", 
          description: errorDetails
        });
        return;
      }

      toast({
        title: "Success",
        description: "Plan execution completed successfully"
      });

      // Reload the plan to show updated status
      loadPlan();
    } catch (error) {
      console.error('Test execution error:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to test execution"
      });
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' (local time)';
  };

  const handlePayment = () => {
    const paymentUrl = "https://buy.stripe.com/test_your_payment_link_here"; // Replace with your actual Stripe payment link
    if (paymentUrl && paymentUrl !== "https://buy.stripe.com/test_your_payment_link_here") {
      window.open(paymentUrl, '_blank');
    } else {
      toast({
        variant: "destructive",
        title: "Payment Link Not Configured",
        description: "Please set up your Stripe payment link in environment variables"
      });
    }
  };

  const shouldShowPayButton = plan && 
    (plan.status === 'success' || plan.status === 'alt_success') && 
    !plan.paid;

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center h-64">
            <div className="text-lg">Loading plan details...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="text-center">
            <p className="text-muted-foreground mb-4">Plan not found</p>
            <Button onClick={() => navigate('/history')}>
              Back to History
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <Button 
            variant="ghost" 
            onClick={() => navigate('/history')}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to History
          </Button>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-2xl">{plan.org}</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge className={getStatusColor(plan.status)}>
                    {getStatusText(plan.status)}
                  </Badge>
                  {(plan.status === 'success' || plan.status === 'alt_success') && (
                    <Badge variant={plan.paid ? "default" : "destructive"}>
                      {plan.paid ? "Paid" : "Unpaid"}
                    </Badge>
                  )}
                  {plan.status === 'scheduled' && (
                    <>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={cancelPlan}
                        className="ml-2"
                      >
                        <X className="h-4 w-4 mr-1" />
                        Cancel Plan
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={testExecution}
                        className="ml-2"
                      >
                        Test Execution
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Preferred Slot</p>
                    <p className="text-sm text-muted-foreground">{plan.preferred}</p>
                  </div>
                </div>
                {plan.alternate && (
                  <div className="flex items-center gap-2">
                    <Target className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Alternate Slot</p>
                      <p className="text-sm text-muted-foreground">{plan.alternate}</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Open Time</p>
                    <p className="text-sm text-muted-foreground">{formatDate(plan.open_time)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Created</p>
                    <p className="text-sm text-muted-foreground">{formatDate(plan.created_at)}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div>
                  <p className="font-medium">Child Name</p>
                  <p className="text-sm text-muted-foreground">{plan.child_name}</p>
                </div>
                <div>
                  <p className="font-medium">Organization URL</p>
                  <p className="text-sm text-muted-foreground break-all">{plan.base_url}</p>
                </div>
                {plan.phone && (
                  <div>
                    <p className="font-medium">Phone</p>
                    <p className="text-sm text-muted-foreground">{plan.phone}</p>
                  </div>
                )}
              </div>

              {shouldShowPayButton && (
                <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-medium text-green-800">Registration Successful!</h3>
                      <p className="text-sm text-green-600">
                        Your registration was completed successfully. Pay the success fee to complete the process.
                      </p>
                    </div>
                    <Button onClick={handlePayment} className="bg-green-600 hover:bg-green-700">
                      <DollarSign className="h-4 w-4 mr-2" />
                      Pay $20
                      <ExternalLink className="h-4 w-4 ml-2" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Execution Log</CardTitle>
          </CardHeader>
          <CardContent>
            <LiveLog planId={plan.id} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}