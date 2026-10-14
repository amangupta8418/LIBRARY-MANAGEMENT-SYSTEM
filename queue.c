#include <stdio.h>
#include <string.h>

#define MAX 50

typedef struct {
    char reqs[MAX][100];
    int front, rear;
} FIFOQueue;

void initQueue(FIFOQueue *q) {
    q->front = -1;
    q->rear = -1;
}

void enqueue(FIFOQueue *q, char *req) {
    if (q->rear == MAX - 1) return;
    if (q->front == -1) q->front = 0;
    strcpy(q->reqs[++q->rear], req);
}

int main(int argc, char *argv[]) {
    FIFOQueue q;
    initQueue(&q);
    for (int i = 1; i < argc; i++) {
        enqueue(&q, argv[i]);
    }
    printf("[");
    for (int i = q.front; i <= q.rear && q.front != -1; i++) {
        printf("\"%s\"%s", q.reqs[i], (i == q.rear) ? "" : ",");
    }
    printf("]\n");
    return 0;
}