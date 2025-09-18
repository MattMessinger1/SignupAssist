import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const editPlanSchema = z.object({
  open_time: z.string().min(1, "Open time is required"),
  preferred: z.string().min(1, "Preferred slot is required"),
  alternate: z.string().optional(),
  child_name: z.string().min(1, "Child name is required"),
  phone: z.string().optional(),
});

type EditPlanFormData = z.infer<typeof editPlanSchema>;

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

interface EditPlanModalProps {
  plan: Plan;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function EditPlanModal({ plan, open, onClose, onSuccess }: EditPlanModalProps) {
  const { toast } = useToast();

  const form = useForm<EditPlanFormData>({
    resolver: zodResolver(editPlanSchema),
    defaultValues: {
      open_time: new Date(plan.open_time).toISOString().slice(0, 16), // Format for datetime-local input
      preferred: plan.preferred,
      alternate: plan.alternate || "",
      child_name: plan.child_name,
      phone: plan.phone || "",
    },
  });

  const onSubmit = async (data: EditPlanFormData) => {
    try {
      const { error } = await supabase
        .from('plans')
        .update({
          open_time: new Date(data.open_time).toISOString(),
          preferred: data.preferred,
          alternate: data.alternate || null,
          child_name: data.child_name,
          phone: data.phone || null,
          status: 'scheduled', // Reset to scheduled so it can be re-executed
        })
        .eq('id', plan.id);

      if (error) throw error;

      // Add a log entry
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: 'Plan edited by user - reset to scheduled status'
      });

      toast({
        title: "Success",
        description: "Plan updated successfully"
      });

      onSuccess();
      onClose();
    } catch (error) {
      console.error('Error updating plan:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update plan"
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Edit Plan - {plan.org}</DialogTitle>
          <DialogDescription>
            Make changes to your plan. Editing will reset the status to "Scheduled" so the plan can be executed again.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="open_time"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Registration Opens At</FormLabel>
                  <FormControl>
                    <Input
                      type="datetime-local"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="preferred"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Preferred Slot</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. 9:00 AM" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="alternate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Alternate Slot (Optional)</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. 10:00 AM" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="child_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Child Name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone (Optional)</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. (555) 123-4567" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">
                Update Plan
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}