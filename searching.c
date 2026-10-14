#include <stdio.h>
#include <string.h>

int binarySearch(char ids[][50], int low, int high, char *target) {
    while (low <= high) {
        int mid = low + (high - low) / 2;
        int cmp = strcmp(ids[mid], target);
        if (cmp == 0) return mid;
        if (cmp < 0) low = mid + 1;
        else high = mid - 1;
    }
    return -1;
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        printf("{\"found\":false}\n");
        return 0;
    }
    char sorted_ids[3][50] = {"BK-101", "BK-102", "BK-103"};
    int pos = binarySearch(sorted_ids, 0, 2, argv[1]);
    if (pos != -1) {
        printf("{\"found\":true,\"index\":%d,\"algorithm\":\"Binary Search O(log n)\"}\n", pos);
    } else {
        printf("{\"found\":false,\"algorithm\":\"Binary Search O(log n)\"}\n");
    }
    return 0;
}