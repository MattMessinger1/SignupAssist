import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, CheckCircle, ExternalLink, CreditCard, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import Header from "@/components/Header";
import { useNavigate } from "react-router-dom";
import LiveLog from "@/components/LiveLog";
import { CredEncKeyModal } from "@/components/CredEncKeyModal";
import { fromZonedTime } from 'date-fns-tz';

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
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York", // Auto-detect user's timezone
    base_url: "",
    preferred_day: "",
    preferred_time: "",
    preferred_class_name: "",
    alternate_day: "",
    alternate_time: "",
    alternate_class_name: "",
    phone: "",
    // Program and Nordic add-ons
    programName: "",
    nordicRental: "",
    nordicColorGroup: "",
    volunteer: "",
    // Payment authorization fields
    expected_lesson_cost: "",
    maximum_charge_limit: "",
    payment_methods_confirmed: false,
    payment_authorization: false,
    terms_accepted: false
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
        !formData.base_url || !formData.preferred_day || !formData.preferred_time ||
        !formData.payment_methods_confirmed || !formData.payment_authorization || !formData.terms_accepted) {
      toast({
        title: "Error",
        description: "Please fill in all required fields and accept the payment terms",
        variant: "destructive",
      });
      return;
    }

    try {
      setSubmitting(true);
      
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated');

      // Convert datetime-local to proper timezone using date-fns-tz
      // The datetime-local input gives us a string like "2025-09-09T19:00"
      // We need to interpret this as being in the user's selected timezone
      const localDateTime = new Date(formData.open_time);
      const adjustedOpenTime = fromZonedTime(localDateTime, formData.timezone).toISOString();

      // Build extras object for program and Nordic add-ons
      const extras: any = {};
      if (formData.programName) extras.programName = formData.programName;
      if (formData.nordicRental) extras.nordicRental = formData.nordicRental;
      if (formData.nordicColorGroup) extras.nordicColorGroup = formData.nordicColorGroup;
      if (formData.volunteer) extras.volunteer = formData.volunteer;

      const payload = {
        user_id: user.id,
        provider_slug: 'skiclubpro',
        org: selectedOrg.name,
        base_url: formData.base_url,
        child_name: formData.child_name,
        open_time: adjustedOpenTime,
        preferred: `${formData.preferred_day} at ${formData.preferred_time}`,
        alternate: formData.alternate_day && formData.alternate_day !== "none" && formData.alternate_time 
          ? `${formData.alternate_day} at ${formData.alternate_time}` 
          : null,
        preferred_class_name: formData.preferred_class_name || null,
        alternate_class_name: formData.alternate_class_name || null,
        credential_id: formData.credential_id,
        phone: formData.phone || null,
        extras: Object.keys(extras).length > 0 ? extras : null
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
      
      // Show rate limit info in success message
      const rateLimitMsg = response.rate_limit_status 
        ? ` (${response.rate_limit_status.remaining} remaining this week)`
        : '';
      
      toast({
        title: "Success",
        description: `Plan scheduled for ${formData.child_name}${rateLimitMsg}. It will execute automatically 5 minutes before the open time.`,
      });

      // Clear form
      setFormData({
        credential_id: "",
        child_name: "",
        open_time: "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
        base_url: "",
        preferred_day: "",
        preferred_time: "",
        preferred_class_name: "",
        alternate_day: "",
        alternate_time: "",
        alternate_class_name: "",
        phone: "",
        // Program and Nordic add-ons
        programName: "",
        nordicRental: "",
        nordicColorGroup: "",
        volunteer: "",
        // Payment authorization fields
        expected_lesson_cost: "",
        maximum_charge_limit: "",
        payment_methods_confirmed: false,
        payment_authorization: false,
        terms_accepted: false
      });

    } catch (error: any) {
      console.error('Failed to create plan:', error);
      
      // Handle rate limit error specifically - check both error message and response data
      const isRateLimited = error.message?.includes("signups/week limit") || 
                           error.context?.body?.rate_limit_exceeded ||
                           error.context?.status === 429;
      
      if (isRateLimited) {
        const rateLimitMessage = error.context?.body?.error || 
                               error.message || 
                               "Rate limit exceeded. Please try again later.";
        toast({
          title: "Rate Limit Exceeded",
          description: rateLimitMessage,
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
                  <p><strong>Open Time:</strong> {new Date(createdPlan.open_time).toLocaleString()} (in your local timezone)</p>
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
                      <p className="text-sm text-muted-foreground">
                        All lesson times below will be shown in this timezone
                      </p>
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
                  <Label htmlFor="program_name">Program Name</Label>
                  <Input
                    id="program_name"
                    value={formData.programName}
                    onChange={(e) => setFormData(prev => ({ ...prev, programName: e.target.value }))}
                    placeholder="e.g., Nordic Kids Wednesday, Nordic Parent Tot Wednesday"
                  />
                  <p className="text-sm text-muted-foreground">
                    Leave blank to use default "Nordic Kids Wednesday"
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Preferred Lesson Slot * <span className="text-sm font-normal text-muted-foreground">(Times shown in {formData.timezone.replace('_', ' ')})</span></Label>
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
                  <div className="space-y-2">
                    <Label htmlFor="preferred_class_name">Class/Lesson Name (Optional)</Label>
                    <Input
                      id="preferred_class_name"
                      value={formData.preferred_class_name}
                      onChange={(e) => setFormData(prev => ({ ...prev, preferred_class_name: e.target.value }))}
                      placeholder="e.g., Beginner Ski Lessons, Intermediate Snowboard"
                    />
                    <p className="text-sm text-muted-foreground">
                      Help the system find the right class when multiple lessons are offered at the same time
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Alternate Lesson Slot (Optional) <span className="text-sm font-normal text-muted-foreground">(Times shown in {formData.timezone.replace('_', ' ')})</span></Label>
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
                          <SelectItem value="none">None</SelectItem>
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
                  <div className="space-y-2">
                    <Label htmlFor="alternate_class_name">Class/Lesson Name (Optional)</Label>
                    <Input
                      id="alternate_class_name"
                      value={formData.alternate_class_name}
                      onChange={(e) => setFormData(prev => ({ ...prev, alternate_class_name: e.target.value }))}
                      placeholder="e.g., Beginner Ski Lessons, Intermediate Snowboard"
                    />
                    <p className="text-sm text-muted-foreground">
                      Help the system find the right class when multiple lessons are offered at the same time
                    </p>
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

                <Card className="border-blue-200 bg-blue-50/30">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-blue-800">Nordic Kids Add-ons (Optional)</CardTitle>
                    <CardDescription className="text-blue-700">
                      Configure options for Nordic Kids lessons (applies to Wednesday classes)
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="nordicRental">Rental Equipment</Label>
                        <Select 
                          value={formData.nordicRental} 
                          onValueChange={(value) => setFormData(prev => ({ ...prev, nordicRental: value }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select rental option" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="full-rental">Full Rental Package</SelectItem>
                            <SelectItem value="skis-only">Skis Only</SelectItem>
                            <SelectItem value="boots-only">Boots Only</SelectItem>
                            <SelectItem value="no-rental">No Rental Needed</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-blue-700">Required for Nordic classes</p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="nordicColorGroup">Color Group</Label>
                        <Select 
                          value={formData.nordicColorGroup} 
                          onValueChange={(value) => setFormData(prev => ({ ...prev, nordicColorGroup: value }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select color group" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="red">Red Group</SelectItem>
                            <SelectItem value="blue">Blue Group</SelectItem>
                            <SelectItem value="green">Green Group</SelectItem>
                            <SelectItem value="yellow">Yellow Group</SelectItem>
                            <SelectItem value="purple">Purple Group</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-blue-700">Defaults to first available option</p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="volunteer">Volunteer Preference</Label>
                        <Select 
                          value={formData.volunteer} 
                          onValueChange={(value) => setFormData(prev => ({ ...prev, volunteer: value }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select volunteer..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="no">No, cannot volunteer</SelectItem>
                            <SelectItem value="instructor">Instructor</SelectItem>
                            <SelectItem value="assistant instructor">Assistant Instructor</SelectItem>
                            <SelectItem value="equipment management">Equipment management (wax, storage, repairs)</SelectItem>
                            <SelectItem value="administrative assistance">Administrative assistance (bibs, flyers, data)</SelectItem>
                            <SelectItem value="equipment hand out/return">Equipment hand out/return</SelectItem>
                            <SelectItem value="hot chocolate leader">Hot Chocolate Leader</SelectItem>
                            <SelectItem value="hot chocolate assistance">Hot Chocolate assistance</SelectItem>
                            <SelectItem value="on-skis floater">On-skis Floater</SelectItem>
                            <SelectItem value="grooming">Grooming</SelectItem>
                            <SelectItem value="bib hand out/return">Bib hand out/return</SelectItem>
                            <SelectItem value="cookie medal creator">Cookie Medal Creator (end of season)</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-blue-700">Defaults to first available option</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Payment Disclosure and Authorization Section */}
                <Card className="border-amber-200 bg-amber-50/50">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-amber-800">
                      <CreditCard className="h-5 w-5" />
                      Payment Authorization Required
                    </CardTitle>
                    <CardDescription className="text-amber-700">
                      This automated service will make purchases on your behalf using your stored payment methods.
                    </CardDescription>
                  </CardHeader>
                   <CardContent className="space-y-4">
                    <div className="bg-white/80 p-4 rounded-lg border border-amber-200">
                      <h4 className="font-semibold text-amber-900 mb-3 flex items-center gap-2">
                        <AlertCircle className="h-4 w-4" />
                        Charge Authorization
                      </h4>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <div className="space-y-2">
                          <Label htmlFor="expected_lesson_cost" className="text-sm font-medium text-amber-900">
                            Expected Lesson Cost *
                          </Label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-amber-700">$</span>
                            <Input
                              id="expected_lesson_cost"
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="75.00"
                              className="pl-6 border-amber-300 focus:border-amber-500"
                              value={formData.expected_lesson_cost}
                              onChange={(e) => setFormData(prev => ({ ...prev, expected_lesson_cost: e.target.value }))}
                              required
                            />
                          </div>
                          <p className="text-xs text-amber-700">The specific cost of the lesson you're booking</p>
                        </div>
                        
                        <div className="space-y-2">
                          <Label htmlFor="maximum_charge_limit" className="text-sm font-medium text-amber-900">
                            Maximum Charge Limit *
                          </Label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-amber-700">$</span>
                            <Input
                              id="maximum_charge_limit"
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="100.00"
                              className="pl-6 border-amber-300 focus:border-amber-500"
                              value={formData.maximum_charge_limit}
                              onChange={(e) => setFormData(prev => ({ ...prev, maximum_charge_limit: e.target.value }))}
                              required
                            />
                          </div>
                          <p className="text-xs text-amber-700">Maximum amount that can be charged (includes lesson cost + transaction fees)</p>
                        </div>
                      </div>
                      
                      <div className="bg-amber-50 p-3 rounded border border-amber-200">
                        <p className="text-xs text-amber-800">
                          <strong>What's included:</strong> The specific lesson cost plus any transaction fees (taxes, processing fees) associated with this purchase. 
                          The maximum charge limit acts as a safety cap - no matter what, your card will never be charged more than this amount during this booking.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-start space-x-2">
                        <Checkbox 
                          id="payment_methods_confirmed"
                          checked={formData.payment_methods_confirmed}
                          onCheckedChange={(checked) => setFormData(prev => ({ ...prev, payment_methods_confirmed: checked === true }))}
                        />
                        <Label htmlFor="payment_methods_confirmed" className="text-sm leading-relaxed cursor-pointer">
                          I confirm that I have valid payment methods (credit card, bank account, etc.) stored and active in my <strong>{selectedOrg?.name}</strong> account, and these payment methods have sufficient funds/credit available for the expected charges.
                        </Label>
                      </div>

                      <div className="flex items-start space-x-2">
                        <Checkbox 
                          id="payment_authorization"
                          checked={formData.payment_authorization}
                          onCheckedChange={(checked) => setFormData(prev => ({ ...prev, payment_authorization: checked === true }))}
                        />
                        <Label htmlFor="payment_authorization" className="text-sm leading-relaxed cursor-pointer">
                          I authorize this automated service to charge up to <strong>${formData.maximum_charge_limit || '[amount]'}</strong> for the specified lesson and associated transaction fees using my stored payment methods in {selectedOrg?.name}. I understand that charges will be processed automatically when the lesson is successfully booked.
                        </Label>
                      </div>

                      <div className="flex items-start space-x-2">
                        <Checkbox 
                          id="terms_accepted"
                          checked={formData.terms_accepted}
                          onCheckedChange={(checked) => setFormData(prev => ({ ...prev, terms_accepted: checked === true }))}
                        />
                        <Label htmlFor="terms_accepted" className="text-sm leading-relaxed cursor-pointer">
                          I accept responsibility for all charges incurred by this automated booking service. I understand that refunds and cancellations are subject to <strong>{selectedOrg?.name}</strong>'s policies, not this service's policies.
                        </Label>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Button 
                  type="submit" 
                  disabled={
                    submitting || 
                    !formData.expected_lesson_cost || 
                    !formData.maximum_charge_limit || 
                    parseFloat(formData.maximum_charge_limit) < parseFloat(formData.expected_lesson_cost) ||
                    !formData.payment_methods_confirmed || 
                    !formData.payment_authorization || 
                    !formData.terms_accepted
                  } 
                  className="w-full"
                >
                  {submitting ? "Scheduling..." : "Authorize & Schedule Plan"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}