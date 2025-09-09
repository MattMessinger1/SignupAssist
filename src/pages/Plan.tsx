import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CheckCircle, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import Header from "@/components/Header";
import { useNavigate } from "react-router-dom";
import LiveLog from "@/components/LiveLog";
import { CredEncKeyModal } from "@/components/CredEncKeyModal";

interface Credential {
  id: string;
  alias: string;
  provider_slug: string;
  created_at: string;
}

interface SelectedOrg {
  name: string;
  subdomain: string;
}

interface Plan {
  id: string;
  child_name: string;
  open_time: string;
  preferred: string;
  org: string;
  base_url: string;
}

export default function Plan() {
  const [selectedOrg, setSelectedOrg] = useState<SelectedOrg | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [createdPlan, setCreatedPlan] = useState<Plan | null>(null);
  const [formData, setFormData] = useState({
    credential_id: "",
    child_name: "",
    open_time: "",
    timezone: "America/New_York", // Default timezone
    base_url: "",
    preferred_day: "",
    preferred_time: "",
    alternate_day: "",
    alternate_time: "",
    phone: ""
  });
  const { toast } = useToast();
  const navigate = useNavigate();

  // Load guards and credentials on mount
  useEffect(() => {
    checkGuards();
    loadCredentials();
  }, []);

  const checkGuards = () => {
    const saved = localStorage.getItem('selectedOrg');
    if (saved) {
      try {
        setSelectedOrg(JSON.parse(saved));
      } catch (error) {
        console.error('Error parsing selectedOrg:', error);
      }
    }
  };

  const loadCredentials = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase.functions.invoke('cred-list');
      
      if (error) throw error;
      
      setCredentials(data || []);
    } catch (error) {
      console.error('Failed to load credentials:', error);
      toast({
        title: "Error",
        description: "Failed to load credentials",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const scheduleExecution = (planId: string, openTime: string) => {
    const now = new Date();
    const scheduledTime = new Date(openTime);
    const delay = Math.max(0, scheduledTime.getTime() - now.getTime());

    console.log(`Scheduling plan ${planId} to run in ${delay}ms (${delay / 1000}s)`);

    setTimeout(async () => {
      try {
        console.log(`Executing plan ${planId} now`);
        await supabase.functions.invoke('run-plan', {
          body: { plan_id: planId }
        });
      } catch (error) {
        console.error('Error executing scheduled plan:', error);
      }
    }, delay);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedOrg) {
      toast({
        title: "Error",
        description: "Please select an organization first",
        variant: "destructive",
      });
      return;
    }

    if (!formData.credential_id || !formData.child_name || !formData.open_time || 
        !formData.base_url || !formData.preferred_day || !formData.preferred_time) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    try {
      setSubmitting(true);
      
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated');

      const payload = {
        user_id: user.id,
        provider_slug: 'skiclubpro',
        org: selectedOrg.name,
        base_url: formData.base_url,
        child_name: formData.child_name,
        open_time: formData.open_time,
        preferred: `${formData.preferred_day} at ${formData.preferred_time}`,
        alternate: formData.alternate_day && formData.alternate_time 
          ? `${formData.alternate_day} at ${formData.alternate_time}` 
          : null,
        credential_id: formData.credential_id,
        phone: formData.phone || null
      };

      // Use create-plan edge function instead of direct insert (includes rate limiting)
      const { data: response, error } = await supabase.functions.invoke('create-plan', {
        body: payload
      });

      if (error) throw error;
      
      if (!response.success) {
        throw new Error(response.error || 'Failed to create plan');
      }

      const plan = response.plan;
      setCreatedPlan(plan);
      
      // Schedule the execution
      scheduleExecution(plan.id, plan.open_time);
      
      // Show rate limit info in success message
      const rateLimitMsg = response.rate_limit_status 
        ? ` (${response.rate_limit_status.remaining} remaining this week)`
        : '';
      
      toast({
        title: "Success",
        description: `Plan scheduled for ${formData.child_name}${rateLimitMsg}`,
      });

      // Clear form
      setFormData({
        credential_id: "",
        child_name: "",
        open_time: "",
        timezone: "America/New_York",
        base_url: "",
        preferred_day: "",
        preferred_time: "",
        alternate_day: "",
        alternate_time: "",
        phone: ""
      });

    } catch (error: any) {
      console.error('Failed to create plan:', error);
      
      // Handle rate limit error specifically
      if (error.message?.includes("You've reached the 3 signups/week limit")) {
        toast({
          title: "Rate Limit Exceeded",
          description: "You've reached the 3 signups/week limit. Please try again next week.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error",
          description: error.message || "Failed to schedule plan",
          variant: "destructive",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Guard checks
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background to-muted">
        <Header />
        <main className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto text-center">
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </main>
      </div>
    );
  }

  if (!selectedOrg) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background to-muted">
        <Header />
        <main className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto">
            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  Organization Required
                </CardTitle>
                <CardDescription>
                  You need to select an organization before creating a plan.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => navigate('/dashboard')} className="w-full">
                  Go to Dashboard to Select Organization
                </Button>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  if (credentials.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background to-muted">
        <Header />
        <main className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto">
            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  Credentials Required
                </CardTitle>
                <CardDescription>
                  You need at least one stored credential before creating a plan.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => navigate('/credentials')} className="w-full">
                  Go to Credentials to Add Account
                </Button>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  // Success state
  if (createdPlan) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background to-muted">
        <Header />
        <main className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto">
            <Card className="border-success">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-success">
                  <CheckCircle className="h-5 w-5" />
                  Plan Scheduled Successfully
                </CardTitle>
                <CardDescription>
                  Your plan has been created and scheduled.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <p><strong>Child:</strong> {createdPlan.child_name}</p>
                  <p><strong>Organization:</strong> {createdPlan.org}</p>
                  <p><strong>Open Time:</strong> {new Date(createdPlan.open_time).toLocaleString()}</p>
                  <p><strong>Preferred Slot:</strong> {createdPlan.preferred}</p>
                  <p><strong>Base URL:</strong> {createdPlan.base_url}</p>
                </div>
                
                {/* Live Log Component */}
                <LiveLog planId={createdPlan.id} />
                
                <div className="flex gap-2">
                  <Button onClick={() => setCreatedPlan(null)} variant="outline">
                    Create Another Plan
                  </Button>
                  <Button onClick={() => navigate('/history')} className="flex items-center gap-2">
                    View History
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted">
      <Header />
      
      <main className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto space-y-8">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-foreground mb-2">Schedule Plan</h1>
            <p className="text-muted-foreground">
              Create a scheduled plan for {selectedOrg.name}
            </p>
            
            {/* Developer Utilities */}
            <div className="mt-4 pt-4 border-t border-muted">
              <p className="text-xs text-muted-foreground mb-2">Developer Utilities</p>
              <CredEncKeyModal />
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Plan Details</CardTitle>
              <CardDescription>
                Fill in the details for your scheduled appointment
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="credential_id">Account *</Label>
                  <Select 
                    value={formData.credential_id} 
                    onValueChange={(value) => setFormData(prev => ({ ...prev, credential_id: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose an account" />
                    </SelectTrigger>
                    <SelectContent>
                      {credentials.map((cred) => (
                        <SelectItem key={cred.id} value={cred.id}>
                          {cred.alias} ({cred.provider_slug})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="child_name">Child Name *</Label>
                  <Input
                    id="child_name"
                    value={formData.child_name}
                    onChange={(e) => setFormData(prev => ({ ...prev, child_name: e.target.value }))}
                    placeholder="Enter child's name"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="open_time">Open Time *</Label>
                  <div className="space-y-2">
                    <Input
                      id="open_time"
                      type="datetime-local"
                      value={formData.open_time}
                      onChange={(e) => setFormData(prev => ({ ...prev, open_time: e.target.value }))}
                      required
                    />
                    <div className="space-y-2">
                      <Label htmlFor="timezone">Confirm Timezone *</Label>
                      <Select 
                        value={formData.timezone} 
                        onValueChange={(value) => setFormData(prev => ({ ...prev, timezone: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select timezone" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="America/New_York">Eastern (EST/EDT)</SelectItem>
                          <SelectItem value="America/Chicago">Central (CST/CDT)</SelectItem>
                          <SelectItem value="America/Denver">Mountain (MST/MDT)</SelectItem>
                          <SelectItem value="America/Los_Angeles">Pacific (PST/PDT)</SelectItem>
                          <SelectItem value="America/Phoenix">Arizona (MST)</SelectItem>
                          <SelectItem value="America/Anchorage">Alaska (AKST/AKDT)</SelectItem>
                          <SelectItem value="Pacific/Honolulu">Hawaii (HST)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="base_url">Known Base URL *</Label>
                  <Input
                    id="base_url"
                    type="url"
                    value={formData.base_url}
                    onChange={(e) => setFormData(prev => ({ ...prev, base_url: e.target.value }))}
                    placeholder="https://example.com/page"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label>Preferred Lesson Slot *</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <Label htmlFor="preferred_day">Day</Label>
                      <Select 
                        value={formData.preferred_day} 
                        onValueChange={(value) => setFormData(prev => ({ ...prev, preferred_day: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select day" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Sunday">Sunday</SelectItem>
                          <SelectItem value="Monday">Monday</SelectItem>
                          <SelectItem value="Tuesday">Tuesday</SelectItem>
                          <SelectItem value="Wednesday">Wednesday</SelectItem>
                          <SelectItem value="Thursday">Thursday</SelectItem>
                          <SelectItem value="Friday">Friday</SelectItem>
                          <SelectItem value="Saturday">Saturday</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="preferred_time">Time</Label>
                      <Input
                        id="preferred_time"
                        type="time"
                        value={formData.preferred_time}
                        onChange={(e) => setFormData(prev => ({ ...prev, preferred_time: e.target.value }))}
                        placeholder="e.g., 09:45"
                        required
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Alternate Lesson Slot (Optional)</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <Label htmlFor="alternate_day">Day</Label>
                      <Select 
                        value={formData.alternate_day} 
                        onValueChange={(value) => setFormData(prev => ({ ...prev, alternate_day: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select day" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">None</SelectItem>
                          <SelectItem value="Sunday">Sunday</SelectItem>
                          <SelectItem value="Monday">Monday</SelectItem>
                          <SelectItem value="Tuesday">Tuesday</SelectItem>
                          <SelectItem value="Wednesday">Wednesday</SelectItem>
                          <SelectItem value="Thursday">Thursday</SelectItem>
                          <SelectItem value="Friday">Friday</SelectItem>
                          <SelectItem value="Saturday">Saturday</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="alternate_time">Time</Label>
                      <Input
                        id="alternate_time"
                        type="time"
                        value={formData.alternate_time}
                        onChange={(e) => setFormData(prev => ({ ...prev, alternate_time: e.target.value }))}
                        placeholder="e.g., 11:30"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number (Optional)</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                    placeholder="+1234567890"
                  />
                  <p className="text-sm text-muted-foreground">
                    Used for SMS notifications when manual action is required (E.164 format)
                  </p>
                </div>

                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? "Scheduling..." : "Schedule Plan"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}