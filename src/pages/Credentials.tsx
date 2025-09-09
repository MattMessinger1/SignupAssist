import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Trash2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import Header from "@/components/Header";

interface Credential {
  id: string;
  alias: string;
  provider_slug: string;
  created_at: string;
}

export default function Credentials() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    provider_slug: "",
    alias: "",
    email: "",
    password: "",
    cvv: ""
  });
  const { toast } = useToast();

  // Load credentials on component mount
  useEffect(() => {
    loadCredentials();
  }, []);

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
    
    if (!formData.provider_slug || !formData.alias || !formData.email || !formData.password) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    try {
      setSubmitting(true);
      
      const payload = {
        provider_slug: formData.provider_slug,
        alias: formData.alias,
        email: formData.email,
        password: formData.password,
        ...(formData.cvv && { cvv: formData.cvv })
      };

      const { data, error } = await supabase.functions.invoke('cred-store', {
        body: payload
      });

      if (error) throw error;

      toast({
        title: "Success",
        description: `Credential "${data.alias}" stored securely`,
      });

      // Clear form
      setFormData({
        provider_slug: "",
        alias: "",
        email: "",
        password: "",
        cvv: ""
      });

      // Refresh the list
      loadCredentials();

    } catch (error) {
      console.error('Failed to store credential:', error);
      toast({
        title: "Error",
        description: "Failed to store credential",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (credentialId: string, alias: string) => {
    if (!confirm(`Are you sure you want to delete "${alias}"?`)) {
      return;
    }

    try {
      const { error } = await supabase.functions.invoke('cred-delete', {
        body: { credential_id: credentialId }
      });

      if (error) throw error;

      toast({
        title: "Success",
        description: `Credential "${alias}" deleted`,
      });

      // Refresh the list
      loadCredentials();

    } catch (error) {
      console.error('Failed to delete credential:', error);
      toast({
        title: "Error",
        description: "Failed to delete credential",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted">
      <Header />
      
      <main className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-8">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-foreground mb-2">Credential Storage</h1>
            <p className="text-muted-foreground">
              Securely store and manage your account credentials with end-to-end encryption
            </p>
          </div>

          {/* Add New Credential Form */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-5 w-5" />
                Add New Credential
              </CardTitle>
              <CardDescription>
                All sensitive data is encrypted before storage. Only you can decrypt it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="provider_slug">Provider Slug *</Label>
                    <Input
                      id="provider_slug"
                      value={formData.provider_slug}
                      onChange={(e) => setFormData(prev => ({ ...prev, provider_slug: e.target.value }))}
                      placeholder="e.g. skiclubpro, gmail, etc."
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="alias">Alias/Name *</Label>
                    <Input
                      id="alias"
                      value={formData.alias}
                      onChange={(e) => setFormData(prev => ({ ...prev, alias: e.target.value }))}
                      placeholder="e.g. My Ski Account"
                      required
                    />
                  </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email/Username *</Label>
                    <Input
                      id="email"
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                      placeholder="your.email@example.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password *</Label>
                    <Input
                      id="password"
                      type="password"
                      value={formData.password}
                      onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                      placeholder="Your secure password"
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="cvv">CVV (Optional)</Label>
                  <Input
                    id="cvv"
                    value={formData.cvv}
                    onChange={(e) => setFormData(prev => ({ ...prev, cvv: e.target.value }))}
                    placeholder="Optional CVV or security code"
                    className="max-w-xs"
                  />
                </div>

                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? "Storing..." : "Store Credential"}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Credentials List */}
          <Card>
            <CardHeader>
              <CardTitle>Your Stored Credentials</CardTitle>
              <CardDescription>
                Manage your encrypted credentials. Only metadata is shown here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-center py-8 text-muted-foreground">
                  Loading credentials...
                </div>
              ) : credentials.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No credentials stored yet. Add one above to get started.
                </div>
              ) : (
                <div className="space-y-4">
                  {credentials.map((cred) => (
                    <div
                      key={cred.id}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div>
                        <h3 className="font-medium">{cred.alias}</h3>
                        <p className="text-sm text-muted-foreground">
                          Provider: {cred.provider_slug}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Created: {new Date(cred.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(cred.id, cred.alias)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}