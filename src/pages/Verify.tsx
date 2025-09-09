import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Shield, CheckCircle } from 'lucide-react';

interface Challenge {
  token: string;
  type: string;
  plan_id: string;
  status: string;
  expires_at: string;
  data?: any;
}

export default function Verify() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cvv, setCvv] = useState('');
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      loadChallenge();
    }
  }, [token]);

  const loadChallenge = async () => {
    try {
      setLoading(true);
      setError(null);

      // First try to get challenge without auth (for public verification)
      const { data, error } = await supabase
        .from('challenges')
        .select('*')
        .eq('token', token)
        .eq('status', 'pending')
        .maybeSingle();

      if (error) {
        console.error('Error loading challenge:', error);
        setError('Failed to load challenge');
        return;
      }

      if (!data) {
        setError('Challenge not found or already completed');
        return;
      }

      // Check if expired
      const now = new Date();
      const expiresAt = new Date(data.expires_at);
      
      if (now > expiresAt) {
        setError('This verification link has expired');
        return;
      }

      setChallenge(data);
    } catch (err) {
      console.error('Error loading challenge:', err);
      setError('Failed to load challenge');
    } finally {
      setLoading(false);
    }
  };

  const handleComplete = async () => {
    if (!challenge || !token) return;

    try {
      setSubmitting(true);

      const body: any = { token };
      
      // Add CVV if it's a CVV challenge and CVV is provided
      if (challenge.type === 'cvv' && cvv) {
        if (cvv.length < 3 || cvv.length > 4) {
          toast({
            title: "Invalid CVV",
            description: "CVV must be 3 or 4 digits",
            variant: "destructive",
          });
          return;
        }
        body.cvv = cvv;
      }

      const { data, error } = await supabase.functions.invoke('challenge-complete', {
        body
      });

      if (error) {
        console.error('Error completing challenge:', error);
        toast({
          title: "Verification Failed",
          description: error.message || "Failed to complete verification",
          variant: "destructive",
        });
        return;
      }

      if (data?.success) {
        setCompleted(true);
        toast({
          title: "Verification Complete",
          description: data.message || "Your verification was successful!",
        });

        // Auto-redirect after a delay
        setTimeout(() => {
          navigate('/dashboard');
        }, 3000);
      } else {
        toast({
          title: "Verification Failed",
          description: "Something went wrong during verification",
          variant: "destructive",
        });
      }
    } catch (err) {
      console.error('Error completing challenge:', err);
      toast({
        title: "Error",
        description: "An unexpected error occurred",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex items-center justify-center space-x-2">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>Loading verification...</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Shield className="h-5 w-5" />
              <span>Verification Error</span>
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/dashboard')} variant="outline" className="w-full">
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              <span>Verification Complete!</span>
            </CardTitle>
            <CardDescription>
              Your verification was successful. You'll be redirected to the dashboard shortly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/dashboard')} className="w-full">
              Go to Dashboard Now
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!challenge) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Challenge Not Found</CardTitle>
            <CardDescription>The verification link is invalid or has expired.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/dashboard')} variant="outline" className="w-full">
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Shield className="h-5 w-5" />
            <span>Quick Verification</span>
          </CardTitle>
          <CardDescription>
            {challenge.type === 'cvv' 
              ? 'Please enter your CVV to complete the signup process'
              : 'Tap continue to proceed with your signup'
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {challenge.type === 'cvv' && (
            <div className="space-y-2">
              <Label htmlFor="cvv">CVV</Label>
              <Input
                id="cvv"
                type="text"
                placeholder="Enter CVV (3-4 digits)"
                value={cvv}
                onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
                maxLength={4}
                className="text-center"
                autoFocus
              />
              <p className="text-sm text-muted-foreground">
                Enter the 3 or 4-digit security code from your credit card
              </p>
            </div>
          )}

          {challenge.type === 'captcha' && (
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-4">
                Tap continue to verify and proceed with your signup
              </p>
            </div>
          )}

          <Button
            onClick={handleComplete}
            disabled={submitting || (challenge.type === 'cvv' && !cvv)}
            className="w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              challenge.type === 'cvv' ? 'Submit CVV' : 'Continue'
            )}
          </Button>

          <div className="text-center text-sm text-muted-foreground">
            This link expires in {Math.max(0, Math.ceil((new Date(challenge.expires_at).getTime() - Date.now()) / 60000))} minutes
          </div>
        </CardContent>
      </Card>
    </div>
  );
}