import { useState } from "react";
import { Copy, RefreshCw, Key } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

export function CredEncKeyModal() {
  const [generatedKey, setGeneratedKey] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const { toast } = useToast();

  const generateKey = () => {
    // Generate 32 random bytes and base64 encode
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = btoa(String.fromCharCode(...keyBytes));
    setGeneratedKey(key);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied to clipboard",
      description: "The encryption key has been copied to your clipboard.",
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Key className="h-4 w-4" />
          Generate CRED_ENC_KEY
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Credential Encryption Key</DialogTitle>
          <DialogDescription>
            Generate a new encryption key or input an existing one for securing stored credentials.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-6">
          {/* Generate New Key Section */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Generate New Key</Label>
            <div className="flex gap-2">
              <Button onClick={generateKey} className="gap-2">
                <RefreshCw className="h-4 w-4" />
                Generate Key
              </Button>
            </div>
            
            {generatedKey && (
              <div className="space-y-2">
                <Textarea
                  value={generatedKey}
                  readOnly
                  className="font-mono text-xs"
                  rows={3}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(generatedKey)}
                  className="gap-2"
                >
                  <Copy className="h-4 w-4" />
                  Copy Key
                </Button>
              </div>
            )}
          </div>

          {/* Manual Input Section */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Or Input Existing Key</Label>
            <Textarea
              placeholder="Paste your existing base64-encoded encryption key here..."
              value={manualKey}
              onChange={(e) => setManualKey(e.target.value)}
              className="font-mono text-xs"
              rows={3}
            />
            {manualKey && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(manualKey)}
                className="gap-2"
              >
                <Copy className="h-4 w-4" />
                Copy Key
              </Button>
            )}
          </div>

          {/* Instructions */}
          <div className="bg-muted/50 p-4 rounded-lg space-y-2">
            <h4 className="font-medium text-sm">Next Steps:</h4>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Copy the encryption key above</li>
              <li>Go to your Supabase project settings</li>
              <li>Navigate to Edge Functions → Secrets</li>
              <li>Add a new secret named <code className="bg-muted px-1 rounded">CRED_ENC_KEY</code></li>
              <li>Paste the key as the secret value</li>
            </ol>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}