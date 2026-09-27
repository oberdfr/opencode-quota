/**
 * opencode-quota — terminal half.
 *
 * Registers `/quota`, asks the server half for a report, and shows it in a
 * dialog. Keeping the command here is what makes it a real slash command rather
 * than a prompt that would spend tokens on a model turn.
 */

import { Plugin } from "@opencode/plugin/tui";
import { QuotaRpc, parseQuotaReport } from "./rpc.ts";
import { formatReport } from "./format.ts";

export default Plugin.define({
  id: "opencode-quota.tui",
  setup(context) {
    const quota = context.client.rpc(QuotaRpc);

    const show = async () => {
      let report: string;
      try {
        const result = await quota.report({});
        report = formatReport(parseQuotaReport(result));
      } catch (error) {
        report = `Could not read quota: ${error instanceof Error ? error.message : String(error)}`;
      }

      // The dialog render is deferred so the freshly awaited text is in scope
      // when Solid first evaluates it.
      context.ui.dialog.set({ size: "large", centered: true });
      context.ui.dialog.show(
        () => (
          <box flexDirection="column" padding={1}>
            <text fg={context.theme.text.base}>Quota</text>
            <text fg={context.theme.text.muted}>{report}</text>
          </box>
        ),
        () => context.ui.dialog.clear(),
      );
    };

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-quota.show",
          title: "Quota",
          description: "Show remaining quota for connected accounts",
          group: "opencode-quota",
          palette: true,
          slash: { name: "quota", aliases: ["quota-report"] },
          run: show,
        },
      ],
    }));
  },
});
