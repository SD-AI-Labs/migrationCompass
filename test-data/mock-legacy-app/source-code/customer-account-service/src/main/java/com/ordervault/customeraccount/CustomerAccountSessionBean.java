package com.ordervault.customeraccount;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.SessionBean;
import javax.ejb.SessionContext;
import javax.ejb.CreateException;
import java.rmi.RemoteException;
import java.util.ArrayList;
import java.util.List;

public class CustomerAccountSessionBean implements SessionBean {

    private SessionContext ctx;
    private CustomerDAO customerDAO = new CustomerDAO();
    private AddressValidationClient addressValidator = new AddressValidationClient();

    public void ejbCreate() throws CreateException {}

    public CustomerProfile getCustomerProfile(String customerId) throws RemoteException {
        try {
            CustomerProfile profile = customerDAO.findProfile(customerId);
            if (profile == null) {
                throw new RemoteException("Customer not found: " + customerId);
            }
            return profile;
        } catch (Exception e) {
            throw new RemoteException("Error retrieving customer profile", e);
        }
    }

    public AddressUpdateResult updateAddress(String customerId, Address address) throws RemoteException {
        AddressUpdateResult result = new AddressUpdateResult();
        result.validationErrors = new ArrayList<>();

        // NOTE: this call is synchronous and unmitigated — see
        // AddressValidationClient's javadoc for the full risk writeup.
        // If the external postal-verification service is slow/down, this
        // line is where the request hangs.
        boolean valid = addressValidator.validate(address);
        if (!valid) {
            result.success = false;
            result.validationErrors.add("Address failed postal verification");
            return result;
        }

        try {
            customerDAO.saveAddress(customerId, address);
            result.success = true;
            return result;
        } catch (Exception e) {
            throw new RemoteException("Error saving address", e);
        }
    }

    /**
     * Loyalty tier recalculation.
     *
     * NOTE ON SCOPE: the real production method (same name, same class) is
     * roughly 400 lines long, accumulated over ~10 years by several
     * different engineers, with no unit tests. It handles year-over-year
     * spend tiering, promotional point multipliers from ~15 historical
     * marketing campaigns (many still special-cased even though the
     * campaigns themselves ended years ago), tier downgrade grace periods,
     * and a handful of manually-added customer-ID exceptions for VIP
     * accounts that were "temporarily" hardcoded and never removed.
     *
     * This snapshot is a condensed excerpt — enough to convey the pattern
     * (magic numbers, nested conditionals, nothing extracted into named
     * methods, hardcoded special cases) without reproducing all ~400 lines.
     * This is exactly the kind of method flagged in architecture-overview.md
     * and dependency-graph.md as the highest-risk logic to migrate: high
     * complexity, zero test coverage, and no single person left on the team
     * who fully understands every branch.
     */
    public LoyaltyRecalcResult recalculateLoyaltyPoints(String customerId) throws RemoteException {
        try {
            List<double[]> spendByYear = customerDAO.findAnnualSpendByYear(customerId);

            int points = 0;
            String tier = "BRONZE";

            // --- representative excerpt of the real ~400-line method ---
            double totalSpend = 0;
            for (double[] yearSpend : spendByYear) {
                totalSpend += yearSpend[1];
            }

            if (totalSpend > 5000) {
                tier = "PLATINUM";
                points = (int) (totalSpend * 2.5);
            } else if (totalSpend > 2000) {
                tier = "GOLD";
                points = (int) (totalSpend * 1.8);
            } else if (totalSpend > 500) {
                tier = "SILVER";
                points = (int) (totalSpend * 1.2);
            } else {
                tier = "BRONZE";
                points = (int) totalSpend;
            }

            // Hardcoded VIP override — added ~2019, "temporary," never removed.
            // A handful of customer IDs like this exist scattered through the
            // real method; none are documented anywhere outside the code itself.
            if ("CUST-0000481".equals(customerId) || "CUST-0002210".equals(customerId)) {
                tier = "PLATINUM";
                points += 5000;
            }

            // Expired 2021 holiday campaign multiplier — campaign ended, but
            // this branch was never removed because nobody was confident it
            // was safe to delete without regression risk.
            // if (isWithinCampaignWindow(...)) { points *= 1.5; }  // dead code, left as-is

            customerDAO.updateLoyalty(customerId, points, tier);

            LoyaltyRecalcResult result = new LoyaltyRecalcResult();
            result.customerId = customerId;
            result.newPointsBalance = points;
            result.newTier = tier;
            return result;

        } catch (Exception e) {
            throw new RemoteException("Error recalculating loyalty points", e);
        }
    }

    public void setSessionContext(SessionContext ctx) { this.ctx = ctx; }
    public void ejbRemove() {}
    public void ejbActivate() {}
    public void ejbPassivate() {}
}
