import React, { useState, useEffect } from 'react';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SelectedOrg {
  name: string;
  subdomain: string;
}

export default function OrgSearchCard() {
  const [selectedOrg, setSelectedOrg] = useState<SelectedOrg | null>(null);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('selectedOrg');
    if (saved) {
      try {
        setSelectedOrg(JSON.parse(saved));
      } catch (error) {
        console.error('Error parsing selectedOrg from localStorage:', error);
      }
    }
  }, []);

  const handleSelect = () => {
    if (inputValue.trim()) {
      const org: SelectedOrg = {
        name: inputValue.trim(),
        subdomain: inputValue.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '')
      };
      
      setSelectedOrg(org);
      localStorage.setItem('selectedOrg', JSON.stringify(org));
      setInputValue('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSelect();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>🏔️ Organization Search</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Blackhawk Ski Club"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
          />
          <Button onClick={handleSelect} disabled={!inputValue.trim()}>
            Select
          </Button>
        </div>
        
        {selectedOrg && (
          <Badge variant="secondary" className="inline-flex">
            Selected: {selectedOrg.name}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}