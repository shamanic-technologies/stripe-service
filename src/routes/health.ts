import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  res.send("Stripe Service API");
});

router.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "stripe-service" });
});

export default router;
