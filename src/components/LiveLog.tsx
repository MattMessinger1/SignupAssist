import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface LogEntry {
  id: number;
  plan_id: string;
  at: string;
  msg: string;
}

interface LiveLogProps {
  planId: string;
}

export default function LiveLog({ planId }: LiveLogProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    try {
      const { data, error } = await supabase
        .from('plan_logs')
        .select('*')
        .eq('plan_id', planId)
        .order('at', { ascending: false })
        .limit(100);

      if (error) {
        console.error('Error fetching logs:', error);
        return;
      }

      if (data) {
        setLogs(data);
        setIsLoading(false);
      }
    } catch (error) {
      console.error('Error in fetchLogs:', error);
    }
  };

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  // Initial fetch
  useEffect(() => {
    fetchLogs();
  }, [planId]);

  // Poll every 3 seconds
  useEffect(() => {
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, [planId]);

  // Set up realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('plan-logs-changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'plan_logs',
          filter: `plan_id=eq.${planId}`
        },
        (payload) => {
          const newLog = payload.new as LogEntry;
          setLogs(prev => [newLog, ...prev].slice(0, 100));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [planId]);

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-lg">Live Execution Log</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-64 w-full" ref={scrollRef}>
          {isLoading ? (
            <div className="text-center text-muted-foreground py-4">
              Loading logs...
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center text-muted-foreground py-4">
              No logs yet. Logs will appear when execution starts.
            </div>
          ) : (
            <div className="space-y-2">
              {logs.slice().reverse().map((log) => (
                <div key={log.id} className="flex gap-2 text-sm">
                  <span className="text-muted-foreground font-mono">
                    [{formatTime(log.at)}]
                  </span>
                  <span className="flex-1">{log.msg}</span>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}