# Databricks notebook source
# DBTITLE 1,Overview
# MAGIC %md
# MAGIC # 01_gold_datasets
# MAGIC
# MAGIC Builds the gold benchmark datasets and the use case configuration for the model catalog, in `serverless_nv91sa_catalog.model_catalog`.
# MAGIC
# MAGIC | Table | Rows | Purpose |
# MAGIC | --- | --- | --- |
# MAGIC | `gold_fraud_detection` | 150 | Masked claim call transcripts, ~30% with fraud triggers |
# MAGIC | `gold_call_summarization` | 100 | Customer-service calls with 3-sentence reference summaries and 4-6 key facts |
# MAGIC | `gold_churn_detection` | 150 | Calls / emails / agent notes with tenure, product count and churn label (~25% true) |
# MAGIC | `use_case_config` | 3 | System prompt (with JSON output contract), metrics, headline metrics, thresholds, daily volume |
# MAGIC
# MAGIC All data is synthetic and generated with a fixed seed, so re-running produces the same `v1` dataset. PII/PCI appears only as placeholders (`[NAME]`, `[POLICY_NO]`, `[CARD_NO]`, ...).
# MAGIC
# MAGIC **Contract:** the benchmark job must read system prompts, metrics and thresholds only from `use_case_config` (never hard-coded).

# COMMAND ----------

# DBTITLE 1,Setup and helpers
import random
from pyspark.sql import types as T

CATALOG = "serverless_nv91sa_catalog"
SCHEMA = "model_catalog"
DATASET_VERSION = "v1"
SEED = 20261106  # fixed seed -> reproducible benchmark data

spark.sql(
    f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA} "
    "COMMENT 'Model catalog: gold benchmark datasets and use case configuration for LLM model evaluation'"
)


def fq(name: str) -> str:
    return f"{CATALOG}.{SCHEMA}.{name}"


def _q(s: str) -> str:
    """Escape a string for use inside a single-quoted SQL literal."""
    return s.replace("\\", "\\\\").replace("'", "\\'")


def write_table(rows, schema, name, table_comment, column_comments):
    """Overwrite a Delta table and apply table + column comments."""
    df = spark.createDataFrame(rows, schema)
    df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq(name))
    spark.sql(f"COMMENT ON TABLE {fq(name)} IS '{_q(table_comment)}'")
    for col, comment in column_comments.items():
        spark.sql(f"ALTER TABLE {fq(name)} ALTER COLUMN {col} COMMENT '{_q(comment)}'")
    print(f"Wrote {fq(name)}: {spark.table(fq(name)).count()} rows")

# COMMAND ----------

# DBTITLE 1,1. gold_fraud_detection
FRAUD_TRIGGERS = [
    "inconsistent_loss_story",
    "pressure_for_fast_payout",
    "recent_policy_change",
    "prior_claims_mentioned",
    "third_party_coaching",
    "document_reluctance",
]
N_FRAUD_RECORDS, N_FRAUD_POSITIVE = 150, 45  # 30% contain fraud triggers

AGENT_OPEN = [
    "Agent: Thank you for calling the claims line, my name is [AGENT_NAME]. May I have your name and policy number?",
    "Agent: Good morning, you've reached claims. Can I start with your name and policy number, please?",
    "Agent: Claims department, this is [AGENT_NAME] speaking. Who do I have on the line?",
]
CUSTOMER_ID = [
    "Customer: Hi, it's [NAME], policy [POLICY_NO].",
    "Customer: Yes, this is [NAME]. My policy number is [POLICY_NO].",
    "Customer: Hello, [NAME] here. The policy is [POLICY_NO] and my number is [PHONE].",
]
LOSSES = [
    ("I was rear-ended at a red light on [ADDRESS] yesterday evening.", "The rear bumper and trunk are damaged and one tail light is broken."),
    ("A pipe burst in my basement overnight.", "The carpet, the drywall and a couch are all soaked."),
    ("My car was broken into in a parking lot at [ADDRESS].", "They smashed the passenger window and took a laptop and a gym bag."),
    ("The hailstorm on Tuesday damaged my roof.", "Several shingles are missing and the gutters are dented."),
    ("There was a grease fire in my kitchen last night.", "The stove and the cabinets above it are burned and there's smoke damage."),
    ("A rock hit my windshield on the highway this morning.", "There's a crack running all the way across the driver's side."),
    ("My bike and some tools were stolen from my garage.", "The garage door was left open for about an hour while I was out."),
    ("A tree branch fell on my parked car during the windstorm.", "The roof of the car is dented and the sunroof is shattered."),
]
AGENT_PROBES = [
    "Agent: I'm sorry to hear that. Can you walk me through what happened?",
    "Agent: Okay, let's get the details down. Can you describe the damage?",
    "Agent: Thanks. What was damaged or taken?",
]
AGENT_ACKS = [
    "Agent: Understood, I'm noting that on the file.",
    "Agent: Okay, thank you for explaining.",
    "Agent: Got it.",
    "Agent: Alright, I've added that to the notes.",
]
CLOSINGS = [
    "Agent: I've opened claim [CLAIM_NO]. An adjuster will contact you within two business days.\nCustomer: Okay, thanks.",
    "Agent: Your claim number is [CLAIM_NO]. You'll get a confirmation email at [EMAIL].\nCustomer: Great, thank you.",
    "Agent: I've documented everything under claim [CLAIM_NO]. Is there anything else I can help with?\nCustomer: No, that's all.",
]
TRIGGER_SNIPPETS = {
    "inconsistent_loss_story": [
        "Customer: Actually, I need to correct myself, it happened in the morning, not the evening like I said a minute ago.",
        "Agent: A moment ago you said nobody was home, but now you mention your roommate saw it happen?\nCustomer: Well, she was home, but she didn't really see it. It's confusing.",
        "Customer: Sorry, it was Saturday, not Tuesday. Or maybe Sunday. The date doesn't really matter, does it?",
    ],
    "pressure_for_fast_payout": [
        "Customer: I really need the money by Friday. Can you just approve it today?",
        "Customer: Is there any way to skip the adjuster and just send the cheque? I can't wait weeks for this.",
        "Customer: If this isn't paid out this week I'll have to take this further. I need it fast.",
    ],
    "recent_policy_change": [
        "Customer: I just increased my coverage limit two weeks ago, so the higher limit applies, right?",
        "Agent: I see the contents coverage was raised on [DATE], about ten days ago.\nCustomer: Yes, good timing I guess.",
        "Customer: I added comprehensive coverage last month, so this should be covered in full.",
    ],
    "prior_claims_mentioned": [
        "Customer: This is the third time this year something like this has happened to me.",
        "Customer: The last time I claimed for the same thing the payout was quick, so I expect the same.",
        "Customer: I had a similar claim with my previous insurer and they paid it without any questions.",
    ],
    "third_party_coaching": [
        "Customer: Hold on, my friend is telling me what to say... he says I should mention the jewelry too.",
        "Customer: My cousin works at a body shop and told me exactly how to word this claim.",
        "Customer: Someone told me to say it was stolen rather than lost, so... it was stolen.",
    ],
    "document_reluctance": [
        "Agent: Could you send us photos and the police report?\nCustomer: I don't really have photos, and I'd rather not involve the police.",
        "Customer: I threw out the receipts. Can't you just take my word for it?",
        "Agent: We'll need a repair estimate.\nCustomer: Do I really have to send that? It's a hassle, I'd rather skip it.",
    ],
}
# Hard negatives: benign statements that resemble triggers but are not fraud signals
BENIGN_SNIPPETS = [
    "Customer: I updated my mailing address last year when I moved. Is that on file?",
    "Customer: I've been with you for twelve years and never made a claim before.",
    "Agent: Can you send photos of the damage?\nCustomer: Sure, I'll email them tonight to the claims address.",
    "Customer: No rush at all, whenever the adjuster can come out is fine.",
    "Customer: My neighbour saw it happen too and is happy to give a statement.",
    "Agent: Do you have the receipts for the items?\nCustomer: Yes, I keep everything in a folder, I'll upload them.",
]
PCI_SNIPPETS = [
    "Customer: Can I pay the deductible with my card [CARD_NO]?\nAgent: The deductible comes off the settlement, so no payment is needed today.",
    "Customer: For the deposit, my bank account is [BANK_ACCOUNT].\nAgent: Thanks, I've set that up for direct deposit.",
]


def build_fraud_transcript(r, triggers, benign):
    loss_open, loss_detail = r.choice(LOSSES)
    lines = [
        r.choice(AGENT_OPEN),
        r.choice(CUSTOMER_ID),
        "Agent: Thank you. How can I help you today?",
        f"Customer: {loss_open}",
        r.choice(AGENT_PROBES),
        f"Customer: {loss_detail}",
    ]
    middle = [r.choice(TRIGGER_SNIPPETS[t]) for t in triggers] + list(benign)
    r.shuffle(middle)
    for idx, snippet in enumerate(middle):
        if not snippet.startswith("Agent:") and lines[-1].split("\n")[-1].startswith("Customer:"):
            lines.append(r.choice(AGENT_ACKS))
        lines.append(snippet)
    if r.random() < 0.3:
        lines.append(r.choice(PCI_SNIPPETS))
    elif lines[-1].split("\n")[-1].startswith("Customer:"):
        lines.append(r.choice(AGENT_ACKS))
    lines.append(r.choice(CLOSINGS))
    return "\n".join(lines)


rng = random.Random(SEED)
positive_idx = set(rng.sample(range(N_FRAUD_RECORDS), N_FRAUD_POSITIVE))
fraud_rows = []
for i in range(N_FRAUD_RECORDS):
    if i in positive_idx:
        k = rng.choices([1, 2, 3], weights=[0.4, 0.4, 0.2])[0]
        picked = set(rng.sample(FRAUD_TRIGGERS, k))
        triggers = [t for t in FRAUD_TRIGGERS if t in picked]  # canonical order
        benign = []
    else:
        triggers = []
        benign = rng.sample(BENIGN_SNIPPETS, rng.choice([1, 2])) if rng.random() < 0.5 else []
    fraud_rows.append((
        f"FRD-{i + 1:04d}",
        build_fraud_transcript(rng, triggers, benign),
        triggers,
        len(triggers) > 0,
        DATASET_VERSION,
    ))

fraud_schema = T.StructType([
    T.StructField("record_id", T.StringType(), False),
    T.StructField("transcript", T.StringType(), False),
    T.StructField("expected_triggers", T.ArrayType(T.StringType()), False),
    T.StructField("is_fraud", T.BooleanType(), False),
    T.StructField("dataset_version", T.StringType(), False),
])
write_table(
    fraud_rows, fraud_schema, "gold_fraud_detection",
    "Gold benchmark for fraud trigger detection: 150 synthetic insurance claim call transcripts with PII/PCI masked "
    "as placeholders (e.g. [NAME], [POLICY_NO], [CARD_NO]). About 30% contain one or more fraud triggers; "
    "non-fraud rows include benign hard negatives.",
    {
        "record_id": "Unique benchmark record id (FRD-nnnn).",
        "transcript": "Masked agent/customer call transcript, one turn per line prefixed with Agent: or Customer:.",
        "expected_triggers": "Ground-truth fraud triggers present in the transcript, from the fixed list: " + ", ".join(FRAUD_TRIGGERS) + ". Empty when no fraud.",
        "is_fraud": "Ground-truth label: true when at least one fraud trigger is present.",
        "dataset_version": "Benchmark dataset version.",
    },
)

# COMMAND ----------

# DBTITLE 1,2. gold_call_summarization
N_SUMMARY_RECORDS = 100
PRODUCTS = ["auto", "home", "condo", "tenant"]
OPEN = "Agent: Thank you for calling, this is [AGENT_NAME]. How can I help?"
CLOSE = "Agent: Is there anything else I can help with today?\nCustomer: No, that's it. Thanks."


def sc_premium_increase(r):
    product = r.choice(PRODUCTS)
    old = r.choice([88, 104, 117, 131, 149, 162]); inc = r.choice([9, 14, 21, 27, 33]); new = old + inc
    cause, cause_fact = r.choice([
        ("a regional rate adjustment applied to all renewals", "regional rate adjustment"),
        ("the claims-free discount being removed after last year's claim", "loss of claims-free discount after last year's claim"),
        ("higher repair and rebuilding costs across the industry", "industry-wide increase in repair costs"),
    ])
    lines = [OPEN,
             f"Customer: Hi, this is [NAME], policy [POLICY_NO]. My {product} insurance renewal came in and the monthly premium went from ${old} to ${new}. Why the jump?",
             "Agent: Let me take a look at your file.",
             f"Agent: The increase is due to {cause}."]
    facts = [f"Policy type: {product} insurance",
             f"Monthly premium increased from ${old} to ${new} at renewal",
             f"Reason for increase: {cause_fact}"]
    s1 = f"The customer called about their {product} insurance renewal because the monthly premium increased from ${old} to ${new}."
    s2 = f"The agent explained that the increase was due to {cause}."
    if r.random() < 0.5:
        d = r.choice([6, 8, 10, 12])
        lines += ["Customer: Is there anything you can do to bring it down?",
                  f"Agent: I can apply a ${d} per month discount for setting up pre-authorized payments. That brings it to ${new - d}.",
                  "Customer: Okay, please do that."]
        facts += [f"Agent applied a ${d}/month pre-authorized payment discount", f"New monthly premium: ${new - d}"]
        s3 = f"The agent applied a ${d} per month pre-authorized payment discount, lowering the premium to ${new - d}."
    else:
        lines += ["Customer: I see. I guess that makes sense.",
                  "Agent: I'll email a breakdown of the renewal to [EMAIL].",
                  "Customer: Thanks."]
        facts += ["No change was made to the policy"]
        s3 = "No changes were made to the policy, and the agent will email the customer a breakdown of the renewal."
        facts += ["Agent will email a renewal breakdown to the customer"] if r.random() < 0.5 else []
    return lines + [CLOSE], f"{s1} {s2} {s3}", facts


def sc_add_vehicle(r):
    year = r.choice([2019, 2020, 2021, 2022, 2023, 2024, 2025])
    car = r.choice(["Toyota RAV4", "Honda Civic", "Ford F-150", "Hyundai Tucson", "Mazda CX-5", "Tesla Model 3"])
    eff = r.choice(["today", "tomorrow", "the first of next month"])
    cost = r.choice([38, 45, 52, 61, 74])
    cov = r.choice(["full coverage including collision and comprehensive", "liability and comprehensive only"])
    financed = r.random() < 0.5
    lines = [OPEN,
             f"Customer: Hi, it's [NAME], policy [POLICY_NO]. I just bought a {year} {car} and need to add it to my auto policy.",
             f"Agent: Congratulations! When would you like coverage to start?",
             f"Customer: Starting {eff}, please.",
             "Agent: What coverage would you like on it?",
             f"Customer: Let's do {cov}.",
             f"Agent: That adds ${cost} per month to your premium."]
    facts = [f"Vehicle added: {year} {car}", f"Coverage effective {eff}", f"Coverage selected: {cov}",
             f"Additional premium: ${cost} per month"]
    s1 = f"The customer called to add a newly purchased {year} {car} to their auto policy, effective {eff}."
    s2 = f"They chose {cov}, which adds ${cost} per month to the premium."
    if financed:
        lines += ["Customer: It's financed through [LENDER_NAME], do you need that?",
                  "Agent: Yes, I've added them as lienholder. I'm emailing your pink slip now."]
        facts += ["Lender [LENDER_NAME] added as lienholder", "Pink slip emailed to the customer"]
        s3 = "Because the vehicle is financed, the agent added the lender as lienholder and emailed the pink slip."
    else:
        lines += ["Agent: I'm emailing your pink slip to [EMAIL] now.", "Customer: Perfect."]
        facts += ["Pink slip emailed to the customer"]
        s3 = "The agent emailed the pink slip to the customer."
    return lines + [CLOSE], f"{s1} {s2} {s3}", facts


def sc_claim_status(r):
    claim = r.choice(["water damage", "auto collision", "hail damage", "theft"])
    status_line, status_sent, status_fact = r.choice([
        ("An adjuster has been assigned and will inspect on [DATE].", "an adjuster has been assigned and an inspection is scheduled", "Status: adjuster assigned, inspection scheduled"),
        ("We received the repair estimate and it's under review.", "the repair estimate was received and is under review", "Status: repair estimate under review"),
        ("A payment of $2,340 was issued by direct deposit yesterday.", "a payment of $2,340 was issued by direct deposit", "Status: $2,340 payment issued by direct deposit"),
    ])
    days = r.choice([2, 3, 5])
    photos = r.random() < 0.5
    lines = [OPEN,
             f"Customer: Hi, this is [NAME]. I'm calling for an update on my {claim} claim, number [CLAIM_NO].",
             "Agent: Let me pull that up.",
             f"Agent: {status_line}",
             f"Agent: You should hear from us with the next update within {days} business days."]
    facts = [f"Claim type: {claim}", "Claim number: [CLAIM_NO]", status_fact, f"Next update expected within {days} business days"]
    s3 = f"The customer will receive the next update within {days} business days"
    if photos:
        lines += ["Agent: It would also help if you uploaded photos of the damage through the online portal.",
                  "Customer: Sure, I'll do that tonight."]
        facts += ["Customer asked to upload damage photos via the online portal"]
        s3 += " and was asked to upload photos of the damage through the online portal."
    else:
        s3 += "."
    s1 = f"The customer called for a status update on their {claim} claim."
    s2 = f"The agent confirmed that {status_sent}."
    return lines + [CLOSE], f"{s1} {s2} {s3}", facts


def sc_payment_update(r):
    day = r.choice(["1st", "15th", "28th"])
    remove_card = r.random() < 0.5
    lines = [OPEN,
             "Customer: Hi, [NAME] here, policy [POLICY_NO]. I'd like to stop paying with my credit card [CARD_NO] and switch to automatic withdrawals from my bank.",
             "Agent: No problem. Which account should we use?",
             "Customer: Account [BANK_ACCOUNT].",
             f"Agent: And which day of the month works best?",
             f"Customer: The {day}, please.",
             "Agent: Done. The first withdrawal will be on [DATE], and I'm sending a confirmation to [EMAIL]."]
    facts = ["Payment method changed from credit card to pre-authorized bank withdrawal",
             f"Withdrawal day: the {day} of each month", "First withdrawal on [DATE]", "Confirmation sent to the customer by email"]
    s3 = "A confirmation was emailed to the customer"
    if remove_card:
        lines += ["Customer: Can you also delete my card from the file?", "Agent: Yes, the card has been removed."]
        facts += ["Credit card removed from the customer's file"]
        s3 += ", and the credit card was removed from the file at the customer's request."
    else:
        s3 += "."
    s1 = "The customer called to switch their premium payments from a credit card to pre-authorized bank withdrawals."
    s2 = f"Withdrawals will occur on the {day} of each month, starting on the scheduled first withdrawal date."
    return lines + [CLOSE], f"{s1} {s2} {s3}", facts


def sc_address_change(r):
    city = r.choice(["Guelph", "Halifax", "Calgary", "Regina", "Kelowna", "Moncton"])
    when = r.choice(["next week", "at the end of the month", "in two weeks"])
    amt = r.choice([4, 7, 11, 15]); up = r.random() < 0.5
    has_home = r.random() < 0.5
    direction = "increases" if up else "decreases"
    lines = [OPEN,
             f"Customer: Hi, it's [NAME], policy [POLICY_NO]. I'm moving to {city} {when} and need to update my address to [ADDRESS].",
             "Agent: Thanks for letting us know. I'll update the address on your auto policy.",
             f"Agent: Based on the new location, your auto premium {direction} by ${amt} per month."]
    facts = [f"Customer is moving to {city}", f"Move date: {when}", "Address updated on the auto policy",
             f"Auto premium {direction} by ${amt} per month"]
    s1 = f"The customer called to update their address because they are moving to {city} {when}."
    s2 = f"The agent updated the auto policy, and the premium {direction} by ${amt} per month due to the new location."
    if has_home:
        lines += ["Customer: What about my home insurance?",
                  "Agent: I'll start a quote for the new home and cancel the current home policy effective on your move date."]
        facts += ["Agent started a home insurance quote for the new address", "Current home policy to be cancelled effective the move date"]
        s3 = "The agent also started a home insurance quote for the new address and will cancel the current home policy on the move date."
    else:
        lines += ["Customer: Great, that's all I needed."]
        s3 = "No other policies needed to be changed."
    return lines + [CLOSE], f"{s1} {s2} {s3}", facts


def sc_roadside(r):
    cost = r.choice([49, 59, 69]); km = r.choice([50, 100, 200])
    rental = r.random() < 0.5
    lines = [OPEN,
             "Customer: Hi, this is [NAME], policy [POLICY_NO]. I'd like to add roadside assistance to my auto policy.",
             f"Agent: Sure. It's ${cost} per year and covers towing up to {km} km, battery boosts and lockouts.",
             "Customer: Sounds good, please add it.",
             "Agent: Done, it's effective immediately."]
    facts = ["Roadside assistance added to the auto policy", f"Cost: ${cost} per year", f"Towing covered up to {km} km", "Coverage effective immediately"]
    s1 = "The customer called to add roadside assistance to their auto policy."
    s2 = f"The coverage costs ${cost} per year, includes towing up to {km} km, and is effective immediately."
    if rental:
        rc = r.choice([3, 5, 6])
        lines += ["Customer: While I have you, can I also get rental car coverage?",
                  f"Agent: Yes, that's ${rc} per month. I've added it."]
        facts += [f"Rental car coverage added for ${rc} per month"]
        s3 = f"The customer also added rental car coverage for ${rc} per month."
    else:
        s3 = "No other changes were requested."
    return lines + [CLOSE], f"{s1} {s2} {s3}", facts


SCENARIOS = [
    ("premium_increase", sc_premium_increase), ("add_vehicle", sc_add_vehicle), ("claim_status", sc_claim_status),
    ("payment_update", sc_payment_update), ("address_change", sc_address_change), ("roadside_addon", sc_roadside),
]

rng = random.Random(SEED + 1)
scenario_plan = [SCENARIOS[i % len(SCENARIOS)] for i in range(N_SUMMARY_RECORDS)]
rng.shuffle(scenario_plan)
summary_rows = []
for i, (sc_name, sc_fn) in enumerate(scenario_plan):
    lines, summary, facts = sc_fn(rng)
    assert 4 <= len(facts) <= 6, (sc_name, facts)
    summary_rows.append((f"SUM-{i + 1:04d}", sc_name, "\n".join(lines), summary, facts, DATASET_VERSION))

summary_schema = T.StructType([
    T.StructField("record_id", T.StringType(), False),
    T.StructField("scenario", T.StringType(), False),
    T.StructField("transcript", T.StringType(), False),
    T.StructField("reference_summary", T.StringType(), False),
    T.StructField("key_facts", T.ArrayType(T.StringType()), False),
    T.StructField("dataset_version", T.StringType(), False),
])
write_table(
    summary_rows, summary_schema, "gold_call_summarization",
    "Gold benchmark for call summarization: 100 synthetic customer-service call transcripts (PII/PCI masked) "
    "with a 3-sentence reference summary and 4-6 key facts per call.",
    {
        "record_id": "Unique benchmark record id (SUM-nnnn).",
        "scenario": "Call scenario used to generate the record (e.g. premium_increase, claim_status).",
        "transcript": "Masked agent/customer call transcript, one turn per line prefixed with Agent: or Customer:.",
        "reference_summary": "Ground-truth summary of exactly 3 sentences, fully supported by the transcript.",
        "key_facts": "Ground-truth list of 4-6 atomic facts a complete summary must cover (used for completeness).",
        "dataset_version": "Benchmark dataset version.",
    },
)

# COMMAND ----------

# DBTITLE 1,3. gold_churn_detection
N_CHURN_RECORDS, N_CHURN_POSITIVE = 150, 38  # ~25% churn

# (first-person statement, third-person agent-note version)
CHURN_SIGNALS = [
    ("I got a quote from another insurer that's about $40 a month cheaper and I'm seriously considering switching.",
     "Customer has a competitor quote about $40/month cheaper and is considering switching."),
    ("What would it cost me to cancel my policy before the renewal date?",
     "Customer asked about cancellation fees before the renewal date."),
    ("Can you send me a letter of experience? My new insurer is asking for it.",
     "Customer requested a letter of experience for a new insurer."),
    ("Honestly, after how my last claim was handled, I don't see a reason to stay.",
     "Customer unhappy with how the last claim was handled; sees no reason to stay."),
    ("My employer now offers group home and auto insurance, so I'm planning to move everything over at renewal.",
     "Customer plans to move home and auto to an employer group plan at renewal."),
    ("This is the second price increase this year and I'm done. Please tell me how to end the policy.",
     "Customer upset about a second increase this year and asked how to end the policy."),
]
NEUTRAL_TOPICS = [
    ("I want to add my teenage son as a driver on my auto policy.", "Customer requested to add teenage son as a driver."),
    ("Can you confirm my next payment date?", "Customer asked to confirm next payment date."),
    ("I'd like to update my email address on file to [EMAIL].", "Customer updated email address on file."),
    ("I'm renovating the kitchen. Do I need to tell you about that for my home policy?", "Customer asked whether a kitchen renovation affects the home policy."),
    ("Can you send a pink slip for my car to [EMAIL]?", "Customer requested a pink slip by email."),
    ("Is my policy number still [POLICY_NO] after the renewal?", "Customer confirmed policy number after renewal."),
]
POSITIVE_TOPICS = [
    ("Thanks for handling my windshield claim so quickly, that was great service.", "Customer complimented quick windshield claim handling."),
    ("I'd like a quote to bundle my condo policy with my auto.", "Customer requested a bundling quote for condo and auto."),
]
# Hard negatives: price or competitor mentions where the customer explicitly stays
HARD_NEGATIVES = [
    ("My premium went up a bit, which isn't great, but after your explanation I'll keep the policy as is.",
     "Customer questioned the premium increase; accepted the explanation and is keeping the policy."),
    ("A friend mentioned a cheaper insurer, but I've been happy with you so I'm not looking to switch.",
     "Customer mentioned a friend's cheaper insurer but said they are not looking to switch."),
    ("I was going to shop around, but the bundling discount you just applied makes it worth staying.",
     "Customer considered shopping around; bundling discount applied and customer is staying."),
]
AGENT_REPLIES = ["Agent: I understand, let me look into that for you.", "Agent: Thanks for telling me. I've noted it on your file.",
                 "Agent: Okay, I can help with that.", "Agent: Let me check what options we have."]


def render_interaction(r, channel, items):
    if channel == "call":
        lines = [r.choice(["Agent: Thanks for calling, this is [AGENT_NAME]. How can I help?",
                           "Agent: Good afternoon, you've reached customer service. What can I do for you?"]),
                 "Customer: Hi, it's [NAME], policy [POLICY_NO].",
                 "Agent: Thanks, I have your file open. Go ahead."]
        for first, _ in items:
            lines += [f"Customer: {first}", r.choice(AGENT_REPLIES)]
        lines += ["Agent: Is there anything else I can help with?", "Customer: No, that's all for now."]
        return "\n".join(lines)
    if channel == "email":
        body = " ".join(first for first, _ in items)
        return f"Subject: Question about my policy [POLICY_NO]\n\nHello,\n\n{body}\n\nThanks,\n[NAME]\n[PHONE]"
    notes = " ".join(third for _, third in items)
    follow = r.choice(["Follow-up task created.", "No further action required at this time.", "Summary sent to customer at [EMAIL]."])
    return f"Agent notes ([DATE]): Inbound contact from [NAME], policy [POLICY_NO]. {notes} {follow}"


rng = random.Random(SEED + 2)
churn_idx = set(rng.sample(range(N_CHURN_RECORDS), N_CHURN_POSITIVE))
churn_rows = []
for i in range(N_CHURN_RECORDS):
    channel = rng.choices(["call", "email", "notes"], weights=[0.45, 0.30, 0.25])[0]
    churn = i in churn_idx
    if churn:
        items = rng.sample(CHURN_SIGNALS, rng.choice([1, 2]))
        if rng.random() < 0.4:
            items.insert(0, rng.choice(NEUTRAL_TOPICS))
        tenure = rng.randint(0, 6) if rng.random() < 0.7 else rng.randint(7, 20)
        products = rng.randint(1, 2) if rng.random() < 0.75 else 3
    else:
        items = rng.sample(NEUTRAL_TOPICS + POSITIVE_TOPICS, rng.choice([1, 2]))
        if rng.random() < 0.3:
            items.append(rng.choice(HARD_NEGATIVES))
        tenure = rng.randint(0, 25)
        products = rng.randint(1, 5)
    churn_rows.append((f"CHN-{i + 1:04d}", channel, render_interaction(rng, channel, items), tenure, products, churn, DATASET_VERSION))

churn_schema = T.StructType([
    T.StructField("record_id", T.StringType(), False),
    T.StructField("channel", T.StringType(), False),
    T.StructField("interaction_text", T.StringType(), False),
    T.StructField("tenure_years", T.IntegerType(), False),
    T.StructField("product_count", T.IntegerType(), False),
    T.StructField("churn_label", T.BooleanType(), False),
    T.StructField("dataset_version", T.StringType(), False),
])
write_table(
    churn_rows, churn_schema, "gold_churn_detection",
    "Gold benchmark for churn detection: 150 synthetic customer interactions (call transcripts, emails or agent notes, "
    "PII masked) with tenure and product count. About 25% are labelled churn; non-churn rows include hard negatives "
    "(price or competitor mentions where the customer explicitly stays).",
    {
        "record_id": "Unique benchmark record id (CHN-nnnn).",
        "channel": "Interaction channel: call, email or notes.",
        "interaction_text": "Masked interaction content (call transcript, customer email, or agent notes).",
        "tenure_years": "Customer tenure in whole years.",
        "product_count": "Number of active insurance products held by the customer.",
        "churn_label": "Ground-truth label: true when the interaction shows intent to leave.",
        "dataset_version": "Benchmark dataset version.",
    },
)

# COMMAND ----------

# DBTITLE 1,4. use_case_config
FRAUD_PROMPT = """You are a claims fraud screening assistant for an insurance company. You will receive a claim call transcript between an agent and a customer. PII and PCI are already masked with placeholders such as [NAME] and [POLICY_NO]; never try to infer them.

Identify which of these fraud triggers are present, using only evidence in the transcript:
- inconsistent_loss_story: the customer's account of the loss changes or contradicts itself (time, place, people, items).
- pressure_for_fast_payout: the customer pushes for immediate payment or to skip normal steps such as an adjuster.
- recent_policy_change: coverage or limits were added or increased shortly before the loss.
- prior_claims_mentioned: the customer mentions previous or repeated claims for similar losses.
- third_party_coaching: someone else is telling the customer what to say or how to word the claim.
- document_reluctance: the customer avoids or refuses to provide photos, receipts, estimates or police reports.
Do not flag benign statements (e.g. offering photos, long tenure without claims, no rush for the adjuster).

Return ONLY a JSON object, no prose or markdown, in exactly this format:
{"triggers": [{"trigger": "<trigger id from the list>", "evidence": "<verbatim quote from the transcript>"}], "is_fraud_risk": <true|false>, "rationale": "<one sentence>"}
Use an empty triggers list when none are present. is_fraud_risk is true if and only if at least one trigger is present."""

SUMMARY_PROMPT = """You are a customer-service call summarization assistant for an insurance company. You will receive a call transcript between an agent and a customer. PII and PCI are masked with placeholders such as [NAME] and [CARD_NO]; keep placeholders as-is and never invent values.

Write a summary of exactly 3 sentences covering: (1) why the customer called, (2) what the agent explained or did, (3) the outcome and any follow-up. Then list 4-6 short atomic key facts (amounts, dates, coverage, actions). Use only information stated in the transcript.

Return ONLY a JSON object, no prose or markdown, in exactly this format:
{"summary": "<exactly 3 sentences>", "key_facts": ["<fact 1>", "<fact 2>", "<fact 3>", "<fact 4>"]}"""

CHURN_PROMPT = """You are a customer retention assistant for an insurance company. You will receive one customer interaction (a call transcript, an email, or agent notes) plus the customer's tenure in years and number of products. PII is masked with placeholders such as [NAME].

Decide whether the customer shows intent to leave (cancel, switch insurer, or not renew). Strong signals include competitor quotes with intent to switch, cancellation or fee questions, requests for a letter of experience, and stated plans to move policies elsewhere. A price complaint or competitor mention where the customer explicitly says they are staying is NOT churn.

Return ONLY a JSON object, no prose or markdown, in exactly this format:
{"churn_risk": <true|false>, "confidence": <number between 0 and 1>, "signals": ["<verbatim quote from the interaction>"], "rationale": "<one sentence>"}
Use an empty signals list when churn_risk is false."""

# thresholds: direction 'gte' = value must be >= threshold, 'lte' = value must be <= threshold.
# cost_per_1k = USD per 1,000 requests; latency_p95_ms = p95 latency in milliseconds.
# metrics = everything 03_run_benchmark computes and writes; 'per_trigger_metrics' expands to
# trigger_precision/recall/f1.<trigger_id> for each fraud trigger.
OPERATIONAL_METRICS = ["latency_p50_ms", "latency_p95_ms", "error_rate", "avg_input_tokens", "avg_output_tokens",
                       "cost_per_1k", "projected_monthly_cost"]
use_case_rows = [
    ("fraud_detection", "Fraud trigger detection - call transcripts", fq("gold_fraud_detection"), FRAUD_PROMPT,
     ["trigger_recall", "trigger_precision", "trigger_f1", "per_trigger_metrics", "fraud_accuracy", "fraud_precision",
      "fraud_recall", "fraud_f1", "json_validity", "faithfulness", "completeness", "conciseness"] + OPERATIONAL_METRICS,
     ["trigger_recall", "faithfulness", "cost_per_1k"],
     {"trigger_recall": ("gte", 0.85), "trigger_precision": ("gte", 0.70), "faithfulness": ("gte", 0.90),
      "json_validity": ("gte", 0.98), "latency_p95_ms": ("lte", 8000.0), "cost_per_1k": ("lte", 10.0)},
     40000),
    ("call_summarization", "Call summarization - customer service", fq("gold_call_summarization"), SUMMARY_PROMPT,
     ["faithfulness", "completeness", "conciseness", "reference_accuracy", "sentence_count_compliance",
      "json_validity"] + OPERATIONAL_METRICS,
     ["faithfulness", "completeness", "cost_per_1k"],
     {"faithfulness": ("gte", 0.90), "completeness": ("gte", 0.80), "json_validity": ("gte", 0.98),
      "latency_p95_ms": ("lte", 10000.0), "cost_per_1k": ("lte", 15.0)},
     25000),
    ("churn_detection", "Churn detection - customer interactions", fq("gold_churn_detection"), CHURN_PROMPT,
     ["f1", "accuracy", "precision", "recall", "json_validity", "faithfulness", "conciseness"] + OPERATIONAL_METRICS,
     ["f1", "accuracy", "cost_per_1k"],
     {"f1": ("gte", 0.75), "accuracy": ("gte", 0.80), "recall": ("gte", 0.75), "json_validity": ("gte", 0.98),
      "latency_p95_ms": ("lte", 5000.0), "cost_per_1k": ("lte", 5.0)},
     15000),
]

threshold_struct = T.StructType([
    T.StructField("direction", T.StringType(), False),
    T.StructField("value", T.DoubleType(), False),
])
config_schema = T.StructType([
    T.StructField("use_case_id", T.StringType(), False),
    T.StructField("display_name", T.StringType(), False),
    T.StructField("gold_table", T.StringType(), False),
    T.StructField("system_prompt", T.StringType(), False),
    T.StructField("metrics", T.ArrayType(T.StringType()), False),
    T.StructField("headline_metrics", T.ArrayType(T.StringType()), False),
    T.StructField("thresholds", T.MapType(T.StringType(), threshold_struct), False),
    T.StructField("daily_volume", T.LongType(), False),
])

for row in use_case_rows:  # guard the config contract
    _, _, _, _, metrics, headline, thresholds, _ = row
    assert set(headline) <= set(metrics) and set(thresholds) <= set(metrics), row[0]

write_table(
    use_case_rows, config_schema, "use_case_config",
    "Use case configuration for the model benchmark: one row per use case. The benchmark job must read system prompts, "
    "metrics and thresholds ONLY from this table (no hard-coded values).",
    {
        "use_case_id": "Stable use case key (fraud_detection, call_summarization, churn_detection).",
        "display_name": "Human-readable use case name shown in the model catalog.",
        "gold_table": "Fully qualified gold benchmark table for this use case.",
        "system_prompt": "System prompt sent to the model, including the required JSON output format.",
        "metrics": "All metrics the benchmark computes and logs for this use case.",
        "headline_metrics": "Metrics shown as headlines; the first entry is the primary metric used for ranking.",
        "thresholds": "Pass/fail thresholds per metric: direction gte (>=) or lte (<=) and value. cost_per_1k is USD per 1,000 requests; latency in ms.",
        "daily_volume": "Expected production requests per day, used for cost projections.",
    },
)

# COMMAND ----------

# DBTITLE 1,Validation
display(spark.sql(f"""
SELECT 'gold_fraud_detection' AS table_name, COUNT(*) AS n_rows, ROUND(AVG(CAST(is_fraud AS INT)), 3) AS positive_rate FROM {fq('gold_fraud_detection')}
UNION ALL SELECT 'gold_call_summarization', COUNT(*), NULL FROM {fq('gold_call_summarization')}
UNION ALL SELECT 'gold_churn_detection', COUNT(*), ROUND(AVG(CAST(churn_label AS INT)), 3) FROM {fq('gold_churn_detection')}
UNION ALL SELECT 'use_case_config', COUNT(*), NULL FROM {fq('use_case_config')}
"""))

# Integrity checks
bad = spark.sql(f"""
SELECT COUNT(*) FROM {fq('gold_fraud_detection')}
WHERE is_fraud <> (size(expected_triggers) > 0)
   OR size(array_except(expected_triggers, array({', '.join(repr(t) for t in FRAUD_TRIGGERS)}))) > 0
""").first()[0]
assert bad == 0, f"{bad} fraud rows with inconsistent labels/triggers"
bad = spark.sql(f"SELECT COUNT(*) FROM {fq('gold_call_summarization')} WHERE size(key_facts) NOT BETWEEN 4 AND 6").first()[0]
assert bad == 0, f"{bad} summarization rows with key_facts outside 4-6"

display(spark.sql(f"SELECT use_case_id, gold_table, headline_metrics[0] AS primary_metric, headline_metrics, thresholds, daily_volume FROM {fq('use_case_config')}"))

# COMMAND ----------

