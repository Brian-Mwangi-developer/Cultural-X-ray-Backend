import { describeSesAccount } from "@/modules/email/email.transport";

// Read-only: proves the credentials work and reports sandbox status. Sends nothing.
describeSesAccount()
  .then((account) => {
    console.log(JSON.stringify(account, null, 2));
    if (!account.productionAccess) {
      console.log("\nSES is in the sandbox for this region: it only delivers to verified addresses.");
    }
    process.exit(0);
  })
  .catch((error: Error) => {
    console.error(`SES check failed: ${error.name}: ${error.message}`);
    process.exit(1);
  });
