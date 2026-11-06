import { OrderService } from "../services/order-service";
const svc = new OrderService();
export function registerOrderRoutes(app: any) { app.get("/api/orders/:id", (req: any, res: any) => res.json(svc.getOrderDetails(req.params.id))); }
