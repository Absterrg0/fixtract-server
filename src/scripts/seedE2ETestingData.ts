import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import connectDB from "../config/db";
import User from "../models/user";
import Project from "../models/project";
import Booking from "../models/booking";

async function main() {
  try {
    console.log("🌱 Starting Comprehensive End-to-End Test Data seeding...");

    // Connect to database
    await connectDB();

    const emails = [
      "professional.test@fixera.be",
      "employee1.test@fixera.be",
      "employee2.test@fixera.be",
      "employee3.test@fixera.be",
      "customer.test@fixera.be",
    ];

    const bookingNumbers = [
      "BK-DAYS-BOOKED",
      "BK-DAYS-PROGRESS",
      "BK-DAYS-COMPLETED",
      "BK-OVERLAP",
      "BK-RFQ-NEW",
      "BK-RFQ-QUOTED",
      "BK-RESCHEDULING",
      "BK-DISPUTED",
      "BK-COMPLETED-REVIEWED",
      "BK-CANCELLED",
    ];

    // 1. Clean up existing test data
    console.log("🧹 Cleaning up old test data...");
    
    // Find professional to get associated projects
    const existingPro = await User.findOne({ email: "professional.test@fixera.be" });
    if (existingPro) {
      await Project.deleteMany({ professionalId: existingPro._id });
      await Booking.deleteMany({
        $or: [
          { customer: existingPro._id },
          { professional: existingPro._id },
        ]
      });
    }

    // Clean up by email and booking number
    await User.deleteMany({ email: { $in: emails } });
    await Booking.deleteMany({ bookingNumber: { $in: bookingNumbers } });
    
    console.log("✅ Cleanup complete.");

    // 2. Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash("password123", saltRounds);

    // 3. Create Professional User
    const professionalId = new mongoose.Types.ObjectId();
    const professional = new User({
      _id: professionalId,
      name: "Marcus Janssen (Test Pro)",
      email: "professional.test@fixera.be",
      phone: "+32471000001",
      password: hashedPassword,
      role: "professional",
      professionalStatus: "approved",
      isEmailVerified: true,
      isPhoneVerified: true,
      hourlyRate: 50,
      currency: "EUR",
      serviceCategories: ["interior", "exterior"],
      businessInfo: {
        companyName: "Janssen Quality Renovations",
        description: "Standard mock company for professional end-to-end testing.",
        city: "Antwerp",
        country: "Belgium",
        postalCode: "2000",
        timezone: "Europe/Brussels",
      },
    });
    await professional.save();
    console.log("👤 Created Professional: Marcus Janssen");

    // 4. Create Employee Users
    const employeeId1 = new mongoose.Types.ObjectId();
    const employeeId2 = new mongoose.Types.ObjectId();
    const employeeId3 = new mongoose.Types.ObjectId();

    const employee1 = new User({
      _id: employeeId1,
      name: "Dirk Peeters (Employee 1)",
      email: "employee1.test@fixera.be",
      phone: "+32471000002",
      password: hashedPassword,
      role: "employee",
      isEmailVerified: true,
      isPhoneVerified: true,
      employee: {
        companyId: professionalId.toString(),
        isActive: true,
      },
    });
    await employee1.save();

    const employee2 = new User({
      _id: employeeId2,
      name: "Sarah Janssens (Employee 2)",
      email: "employee2.test@fixera.be",
      phone: "+32471000003",
      password: hashedPassword,
      role: "employee",
      isEmailVerified: true,
      isPhoneVerified: true,
      employee: {
        companyId: professionalId.toString(),
        isActive: true,
      },
      blockedDates: [
        { date: new Date("2026-07-10T00:00:00.000Z"), reason: "Vacation / Blocked" },
      ],
    });
    await employee2.save();

    const employee3 = new User({
      _id: employeeId3,
      name: "Johan Maes (Employee 3)",
      email: "employee3.test@fixera.be",
      phone: "+32471000004",
      password: hashedPassword,
      role: "employee",
      isEmailVerified: true,
      isPhoneVerified: true,
      employee: {
        companyId: professionalId.toString(),
        isActive: true,
      },
    });
    await employee3.save();

    console.log("👥 Created 3 Active Employees");

    // 5. Create Customer User
    const customerId = new mongoose.Types.ObjectId();
    const customer = new User({
      _id: customerId,
      name: "Jean Dupont (Test Customer)",
      email: "customer.test@fixera.be",
      phone: "+32471000005",
      password: hashedPassword,
      role: "customer",
      isEmailVerified: true,
      isPhoneVerified: true,
      customerType: "individual",
    });
    await customer.save();
    console.log("👤 Created Customer: Jean Dupont");

    // 6. Create Days-mode Project
    const projectIdDays = new mongoose.Types.ObjectId();
    const projectDays = new Project({
      _id: projectIdDays,
      title: "Premium Kitchen Renovation (Days Mode)",
      description: "A complete end-to-end days-mode renovation project for timeline testing and validation.",
      professionalId: professionalId,
      category: "Renovation",
      service: "Kitchen Renovation",
      priceModel: "fixed",
      status: "published",
      timeMode: "days",
      executionDuration: { value: 15, unit: "days" },
      distance: {
        address: "Antwerp, Belgium",
        maxKmRange: 50,
        useCompanyAddress: true,
        noBorders: false,
      },
      media: { images: ["https://images.unsplash.com/photo-1556911220-e15b29be8c8f"] },
    });
    await projectDays.save();

    // 7. Create Hours-mode Project
    const projectIdHours = new mongoose.Types.ObjectId();
    const projectHours = new Project({
      _id: projectIdHours,
      title: "Quick Leak Repair (Hours Mode)",
      description: "A quick hours-mode plumbing repair project. Rescheduling is sufficient here.",
      professionalId: professionalId,
      category: "Plumbing",
      service: "Leak Repair",
      priceModel: "fixed",
      status: "published",
      timeMode: "hours",
      executionDuration: { value: 4, unit: "hours" },
      distance: {
        address: "Antwerp, Belgium",
        maxKmRange: 50,
        useCompanyAddress: true,
        noBorders: false,
      },
      media: { images: ["https://images.unsplash.com/photo-1584622650111-993a426fbf0a"] },
    });
    await projectHours.save();
    console.log("📦 Created 2 Projects (Days-mode & Hours-mode)");

    // 8. Seeding Booking Lifecycle Stages
    
    // --- LIFECYCLE STAGE 1: NEW RFQ REQUEST ---
    const bookingRfq = new Booking({
      bookingNumber: "BK-RFQ-NEW",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "rfq",
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Antwerp North",
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "I need to renovate my kitchen. Floors need tiling, and new wooden cabinets need to be installed. Photos attached.",
        answers: [
          { question: "Describe the room or area that needs work.", answer: "Standard kitchen, approx 15 square meters." },
          { question: "How urgent is this quotation request?", answer: "Within 2 weeks" },
        ],
        preferredStartDate: new Date("2026-07-20T00:00:00.000Z"),
        urgency: "medium",
        budget: { min: 2000, max: 4000, currency: "EUR" },
      },
      messages: [
        {
          senderId: customerId,
          message: "Hello, I just requested a quote. Let me know if you need more details or want to drop by the apartment.",
          timestamp: new Date(Date.now() - 3600000),
        }
      ],
    });
    await bookingRfq.save();

    // --- LIFECYCLE STAGE 2: QUOTED (WAITING FOR CUSTOMER) ---
    const bookingQuoted = new Booking({
      bookingNumber: "BK-RFQ-QUOTED",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "quoted",
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Antwerp South",
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "Quoted kitchen tiling and painting.",
        answers: [],
      },
      quote: {
        amount: 2500,
        currency: "EUR",
        submittedAt: new Date(),
        submittedBy: professionalId,
      },
      quoteVersions: [
        {
          version: 1,
          quotationNumber: "QT-2026-0001",
          scope: "Kitchen renovation including cabinets & floors",
          warrantyDuration: { value: 2, unit: "years" },
          materialsIncluded: true,
          description: "Detailed quotation for flooring, painting and cabinet mounting.",
          totalAmount: 2500,
          currency: "EUR",
          preparationDuration: { value: 2, unit: "days" },
          executionDuration: { value: 5, unit: "days" },
          validUntil: new Date("2026-08-01"),
          createdAt: new Date(),
          milestones: [
            {
              title: "Milestone 1: Surface Prep & Floor Tiling",
              amount: 1250,
              description: "50% paid upfront for prep work and materials.",
              dueCondition: "on_start",
              order: 1,
              status: "pending",
            },
            {
              title: "Milestone 2: Cabinet Mounting & Painting",
              amount: 1250,
              description: "Remaining 50% upon final completion attestation.",
              dueCondition: "on_milestone_completion",
              order: 2,
              status: "pending",
            }
          ]
        }
      ],
      currentQuoteVersion: 1,
      messages: [
        {
          senderId: customerId,
          message: "Thanks for checking. Looking forward to the quote.",
          timestamp: new Date(Date.now() - 7200000),
        },
        {
          senderId: professionalId,
          message: "Hi Jean, I submitted the quote detailing the milestones and materials. Please let me know if it works for you.",
          timestamp: new Date(Date.now() - 600000),
        }
      ],
    });
    await bookingQuoted.save();

    // --- LIFECYCLE STAGE 3: BOOKED (INITIAL PLANNING NEEDED) ---
    const bookingBooked = new Booking({
      bookingNumber: "BK-DAYS-BOOKED",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "booked",
      scheduledStartDate: new Date("2026-07-01T00:00:00.000Z"),
      scheduledExecutionEndDate: new Date("2026-07-15T00:00:00.000Z"),
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Antwerp Center",
      },
      quote: {
        amount: 3000,
        currency: "EUR",
        submittedAt: new Date(),
        submittedBy: professionalId,
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "Full renovation of test kitchen.",
        answers: [],
      },
    });
    await bookingBooked.save();

    // --- LIFECYCLE STAGE 4: IN PROGRESS (ACTIVE TIMELINE) ---
    const today = new Date();
    const tenDaysAgo = new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000);
    const fiveDaysAgo = new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000);
    const tenDaysAhead = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000);

    const bookingProgress = new Booking({
      bookingNumber: "BK-DAYS-PROGRESS",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "in_progress",
      scheduledStartDate: tenDaysAgo,
      scheduledExecutionEndDate: tenDaysAhead,
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Antwerp Suburb",
      },
      quote: {
        amount: 4500,
        currency: "EUR",
        submittedAt: new Date(),
        submittedBy: professionalId,
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "Ongoing kitchen project with past days already planned.",
        answers: [],
      },
      assignedTeamMembers: [professionalId],
      resourcePlan: [
        {
          resourceId: professionalId,
          startDate: tenDaysAgo,
          endDate: fiveDaysAgo,
        }
      ],
    });
    await bookingProgress.save();

    // --- LIFECYCLE STAGE 5: RESCHEDULING REQUESTED ---
    const bookingRescheduling = new Booking({
      bookingNumber: "BK-RESCHEDULING",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "rescheduling_requested",
      scheduledStartDate: new Date("2026-07-05T00:00:00.000Z"),
      scheduledExecutionEndDate: new Date("2026-07-15T00:00:00.000Z"),
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Antwerp Central Station Area",
      },
      quote: {
        amount: 3200,
        currency: "EUR",
        submittedAt: new Date(),
        submittedBy: professionalId,
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "Rescheduling test booking.",
        answers: [],
      },
      rescheduleRequest: {
        status: "pending",
        requestedBy: professionalId,
        requestedAt: new Date(),
        reason: "Delay in current project materials delivery.",
        description: "We had a delay in importing the premium tiling adhesive and need to shift the start date by 4 days.",
        proposedSchedule: {
          scheduledStartDate: new Date("2026-07-09T00:00:00.000Z"),
          scheduledExecutionEndDate: new Date("2026-07-19T00:00:00.000Z"),
        }
      }
    });
    await bookingRescheduling.save();

    // --- LIFECYCLE STAGE 6: DISPUTED ---
    const bookingDisputed = new Booking({
      bookingNumber: "BK-DISPUTED",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "dispute",
      scheduledStartDate: new Date("2026-06-01T00:00:00.000Z"),
      scheduledExecutionEndDate: new Date("2026-06-12T00:00:00.000Z"),
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Antwerp Harbor Area",
      },
      quote: {
        amount: 2800,
        currency: "EUR",
        submittedAt: new Date(),
        submittedBy: professionalId,
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "Disputed project.",
        answers: [],
      },
      dispute: {
        raisedBy: customerId,
        reason: "Poor Workmanship / Incomplete Service",
        description: "The cabinets were mounted unevenly, and paint streaks are visible on the ceiling. I reached out to the professional but haven't received a resolution.",
        raisedAt: new Date(Date.now() - 86400000), // 1 day ago
        type: "in_progress",
        slaDeadline: new Date(Date.now() + 86400000 * 3), // 3 days SLA
      }
    });
    await bookingDisputed.save();

    // --- LIFECYCLE STAGE 7: COMPLETED, EXTRA COSTS PAID & REVIEWED ---
    const bookingCompleted = new Booking({
      bookingNumber: "BK-COMPLETED-REVIEWED",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "completed",
      scheduledStartDate: new Date("2026-05-10T00:00:00.000Z"),
      scheduledExecutionEndDate: new Date("2026-05-20T00:00:00.000Z"),
      actualStartDate: new Date("2026-05-10T08:00:00.000Z"),
      actualEndDate: new Date("2026-05-19T17:00:00.000Z"),
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Ghent Center",
      },
      quote: {
        amount: 3500,
        currency: "EUR",
        submittedAt: new Date(),
        submittedBy: professionalId,
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "Fully completed and reviewed renovation project.",
        answers: [],
      },
      milestonePayments: [
        {
          title: "Initial prep payment",
          amount: 1750,
          dueCondition: "on_start",
          order: 1,
          status: "paid",
          workStatus: "completed",
          paidAt: new Date("2026-05-10"),
        },
        {
          title: "Final completion payment",
          amount: 1750,
          dueCondition: "on_milestone_completion",
          order: 2,
          status: "paid",
          workStatus: "completed",
          paidAt: new Date("2026-05-19"),
        }
      ],
      completionAttestation: {
        confirmedAt: new Date("2026-05-19T18:00:00.000Z"),
        confirmedBy: customerId,
        notes: "Work looks fantastic! All cabinets fit perfectly and flooring is clean.",
      },
      extraCosts: [
        {
          type: "unit_adjustment",
          name: "Additional paint coating",
          justification: "Walls were highly porous, requiring one extra paint coat for uniform coverage.",
          amount: 150,
        }
      ],
      extraCostStatus: "confirmed",
      extraCostTotal: 150,
      customerReview: {
        communicationLevel: 5,
        valueOfDelivery: 5,
        qualityOfService: 5,
        comment: "Excellent service from Marcus! He was polite, finished ahead of schedule, and did a premium job.",
        reviewedAt: new Date("2026-05-20T10:00:00.000Z"),
      },
      professionalReview: {
        rating: 5,
        comment: "Jean was an excellent client. Clear instructions, prompt payment, and very friendly workspace environment.",
        reviewedAt: new Date("2026-05-20T12:00:00.000Z"),
      }
    });
    await bookingCompleted.save();

    // --- LIFECYCLE STAGE 8: CANCELLED ---
    const bookingCancelled = new Booking({
      bookingNumber: "BK-CANCELLED",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "cancelled",
      scheduledStartDate: new Date("2026-06-01T00:00:00.000Z"),
      scheduledExecutionEndDate: new Date("2026-06-15T00:00:00.000Z"),
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Antwerp Outskirts",
      },
      quote: {
        amount: 4000,
        currency: "EUR",
        submittedAt: new Date(),
        submittedBy: professionalId,
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "Renovation cancelled.",
        answers: [],
      },
      cancellation: {
        cancelledBy: customerId,
        reason: "Client had an emergency relocation and could no longer proceed with the renovation contract.",
        cancelledAt: new Date(Date.now() - 86400000 * 5), // 5 days ago
      }
    });
    await bookingCancelled.save();

    // --- LIFECYCLE STAGE 9: OVERLAPPING HELPER BOOKING ---
    const bookingOverlap = new Booking({
      bookingNumber: "BK-OVERLAP",
      customer: customerId,
      bookingType: "project",
      project: projectIdDays,
      status: "booked",
      scheduledStartDate: new Date("2026-07-08T00:00:00.000Z"),
      scheduledExecutionEndDate: new Date("2026-07-10T00:00:00.000Z"),
      assignedTeamMembers: [employeeId1],
      location: {
        type: "Point",
        coordinates: [4.4025, 51.2194],
        address: "Antwerp West",
      },
      quote: {
        amount: 1000,
        currency: "EUR",
        submittedAt: new Date(),
        submittedBy: professionalId,
      },
      rfqData: {
        serviceType: "Kitchen Renovation",
        description: "Overlapping helper booking.",
        answers: [],
      },
    });
    await bookingOverlap.save();

    console.log("📅 Seeded all lifecycle bookings (RFQs, Quotes, Rescheduling, Disputes, Completions, Reviews, Cancellations)");
    console.log("\n🚀 End-to-End Test Data Seeded Successfully!");
    
    console.log("\n==================================================================");
    console.log("🔑 LOGIN CREDENTIALS & SEED INFO");
    console.log("==================================================================");
    console.log("COMMON PASSWORD FOR ALL ACCOUNTS: password123");
    console.log("------------------------------------------------------------------");
    console.log("1. PROFESSIONAL ACCOUNT:");
    console.log("   - Email:    professional.test@fixera.be");
    console.log("   - Name:     Marcus Janssen (Test Pro)");
    console.log("   - Company:  Janssen Quality Renovations");
    console.log("   - Employees: 3 active employees seeded under this company:");
    console.log("     * Dirk Peeters (employee1.test@fixera.be)");
    console.log("     * Sarah Janssens (employee2.test@fixera.be) - Blocked: July 10, 2026");
    console.log("     * Johan Maes (employee3.test@fixera.be)");
    console.log("------------------------------------------------------------------");
    console.log("2. CUSTOMER ACCOUNT:");
    console.log("   - Email:    customer.test@fixera.be");
    console.log("   - Name:     Jean Dupont (Test Customer)");
    console.log("------------------------------------------------------------------");
    console.log("3. SEEDED LIFECYCLE BOOKINGS:");
    console.log("   - BK-RFQ-NEW (RFQ): Customer requested kitchen cabinet installation.");
    console.log("   - BK-RFQ-QUOTED (Quoted): Quote versions (2 milestones) submitted, with messages.");
    console.log("   - BK-DAYS-BOOKED (Booked): Ready for initial resource planning board.");
    console.log("   - BK-DAYS-PROGRESS (In Progress): Active project, timeline starts from Today.");
    console.log("   - BK-RESCHEDULING (Rescheduling): Pro proposed delay of 4 days, awaiting client.");
    console.log("   - BK-DISPUTED (Dispute): Customer raised dispute for uneven cabinet mounting.");
    console.log("   - BK-COMPLETED-REVIEWED (Completed): Milestones paid, reviews written (5 stars).");
    console.log("   - BK-CANCELLED (Cancelled): Relocation emergency cancellation details.");
    console.log("==================================================================\n");

    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding test data:", error);
    process.exit(1);
  }
}

main();
