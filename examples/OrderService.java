package demo;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class OrderService {
    public boolean run(Integer left, Integer right) {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        pool.shutdown();
        return left == right;
    }
}
