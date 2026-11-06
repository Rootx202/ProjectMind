import { OrderRepository } from "../models/order-model";
export class OrderService { private repo = new OrderRepository(); public getOrderDetails(id: string) { return this.repo.findOrderById(id); } }
